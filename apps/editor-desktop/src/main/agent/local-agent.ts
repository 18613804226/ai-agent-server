import {
    AgentOrchestrator,
    classifyComplexity,
    formatRoutingThought,
    loadModelCascadeConfig,
    resolveModelCandidates,
    SimpleLock,
    type AgentDefinition,
    type AgentEvent,
    type FileChange,
    type FileEdit,
  } from '@repo/agent-orchestrator';
import { createEditorAgent } from '@repo/editor-agent';
import { getConfig } from '../config.js';
import { resolveModel } from './model.js';

/**
 * 本地模式：编排器 + 工具都跑在 Electron 主进程，直接编辑用户打开的本地项目。
 *
 * 支持多个工作区文件夹（VS Code 多根）；首次启动不预置工作区。
 * 模型客户端是懒加载的，读工作区/列目录不需要 API Key。
 */
export class LocalAgent {
  private orchestrator: AgentOrchestrator | null = null;
  private workspaceRoots: string[];
  private agent: AgentDefinition | null = null;
  /** 本轮工具产生的文件改动 */
  private changes: FileChange[] = [];

  constructor(initialRoots: string[]) {
    this.workspaceRoots = [...initialRoots];
    this.rebuildAgent();
  }

  get roots(): string[] {
    return [...this.workspaceRoots];
  }

  /** 主工作区（终端 cwd / 兼容旧接口） */
  get root(): string | null {
    return this.workspaceRoots[0] || null;
  }

  setWorkspace(roots: string[]): void {
    this.workspaceRoots = [...roots];
    this.rebuildAgent();
  }

  addWorkspace(root: string): void {
    if (this.workspaceRoots.includes(root)) return;
    this.workspaceRoots.push(root);
    this.rebuildAgent();
  }

  removeWorkspace(root: string): void {
    if (!this.workspaceRoots.includes(root)) return;
    this.workspaceRoots = this.workspaceRoots.filter((r) => r !== root);
    this.rebuildAgent();
  }

  /** 清空工作区：不再持有 agent / 编排器，后续操作要求重新打开文件夹 */
  clearWorkspace(): void {
    this.workspaceRoots = [];
    this.agent = null;
    this.orchestrator = null;
    this.changes = [];
  }

  /** 设置变更后丢弃旧编排器，下次运行时用新配置重建 */
  reloadConfig(): void {
    this.orchestrator = null;
  }

  /** 云端模式：后端把工具调用转回来，由主进程在本地执行 */
  async execTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const agent = this.ensureAgent();
    const tool = agent.tools.find(
      (t) => t.definition.function.name === name,
    );
    if (!tool) return `未知工具：${name}`;
    return await tool.handler(args);
  }

  private rebuildAgent(): void {
    this.agent = this.workspaceRoots.length
      ? createEditorAgent(this.workspaceRoots, (change) =>
          this.changes.push(change),
        )
      : null;
  }

  private ensureAgent(): AgentDefinition {
    if (!this.workspaceRoots.length || !this.agent) {
      throw new Error('请先点击「打开文件夹」选择项目');
    }
    return this.agent;
  }

  private ensureOrchestrator(): AgentOrchestrator {
    if (!this.orchestrator) {
      const cfg = getConfig();
      // 本地模式用「用户选的模型」，key 从 provider.apiKeyEnv 指向的环境变量读
      const resolved = resolveModel(cfg.providers, cfg.selectedModel);
      const model = resolved.model.id;
      // 所有档位都指向同一个模型，避免用户只配了一个 provider 却级联到别的模型
      const modelConfig = loadModelCascadeConfig({
        textSimple: model,
        textComplex: model,
        textExpert: model,
        visionPrimary: model,
        fallback: model,
        textComplexFallback: model,
      });
      this.orchestrator = new AgentOrchestrator({
        getClient: () => resolved.client,
        modelConfig,
        showRoutingThought: true,
        rateLimitRetries: 2,
        zhipuLock: new SimpleLock(),
      });
    }
    return this.orchestrator;
  }

  async *run(
    query: string,
    signal: AbortSignal,
    history: Array<{ role: string; content: string }> = [],
  ): AsyncGenerator<AgentEvent> {
    const agent = this.ensureAgent();
    const orchestrator = this.ensureOrchestrator();
    this.changes = [];

    const complexity = classifyComplexity({
      userQuery: query,
      hasImages: false,
    });
    const candidates = resolveModelCandidates(
      complexity,
      orchestrator.modelConfig,
      { zhipuAvailable: orchestrator.zhipuAvailable },
    );

    if (orchestrator.showRoutingThought && candidates.length) {
      yield {
        type: 'thought',
        content: formatRoutingThought(
          complexity,
          candidates,
          orchestrator.modelConfig,
        ),
      };
    }

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: agent.buildSystemPrompt() },
      ...history
        .filter((m) => typeof m.content === 'string' && m.content.trim())
        .slice(-20),
      { role: 'user', content: query },
    ];

for await (const ev of orchestrator.run({
        messages,
        tools: agent.tools,
        candidates,
        complexity,
        signal,
      })) {
        // 把本轮文件改动挂到 done 事件上，渲染层据此展示 diff；
        // file_edit 事件原样透传，供编辑器做流式动画
        if (ev.type === 'done') {
          yield { ...ev, changes: this.changes };
        } else if (ev.type === 'file_edit') {
          yield ev;
        } else {
          yield ev;
        }
      }
  }
}
