import {
    AgentOrchestrator,
    classifyComplexity,
    loadModelCascadeConfig,
    resolveModelCandidates,
    SimpleLock,
    type AgentDefinition,
    type AgentEvent,
    type AgentPromptContext,
    type ApprovalHook,
    type ApprovalPolicy,
    type ClarificationHook,
    type FileChange,
    type FileEdit,
  } from '@repo/agent-orchestrator';
import { createEditorAgent, previewApproval, restoreChanges } from '@repo/editor-agent';
import type { PendingEditStore } from '@repo/editor-agent';
import { ArtifactStore } from '@repo/agent-orchestrator';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getDatabaseManager } from '../database.js';
import { mcpManager } from '../mcp.js';
import { resolveModel } from './model.js';
import { RunStore, type RunCheckpoint, type RunState } from './run-store.js';

/** 写/删/移动/危险终端命令需要人工审批 */
const APPROVAL_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'move_file',
]);
const RISKY_COMMAND =
  /(^|\s)(rm|rd|del|format|mkfs|shutdown|reboot|dd|sudo|chmod|chown|git\s+push|git\s+reset|npm\s+publish|pnpm\s+publish|yarn\s+publish)\b/i;

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
  /** 同一轮 pending 改动的叠加状态（后续编辑基于未落盘内容） */
  private readonly pendingEdits: PendingEditStore = new Map();
  /** 文件操作审批开启：改动不直接落盘，产出 pending diff 等用户确认 */
  private deferWrite = false;
  /** 等待渲染层响应的审批请求 */
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  /** 等待渲染层响应的澄清请求（ask_user） */
  private readonly pendingClarifications = new Map<string, (answer: string) => void>();
  /** 审批事件出口；未设置时自动放行（避免无 UI 场景挂起） */
  private eventSink: ((ev: unknown) => void) | null = null;
  /** 断点续跑状态机 */
  private readonly store = new RunStore();
  private runState: RunState = 'idle';
  private pausing = false;
  private cancelling = false;
  private currentAbort: AbortController | null = null;
  private resumeFrom: RunCheckpoint | null = null;
  private checkpointId: string = randomUUID();
  /** 云端代理执行（execTool）用的 artifact 存储 */
  private readonly execArtifacts = new ArtifactStore();

  constructor(initialRoots: string[]) {
    this.workspaceRoots = [...initialRoots];
    this.rebuildAgent();
    // MCP 连接完成/配置变化后，重建工具列表
    mcpManager.onChange(() => this.rebuildAgent());
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
    this.pendingEdits.clear();
  }

  /** 设置变更后丢弃旧编排器，下次运行时用新配置重建 */
  reloadConfig(): void {
    this.orchestrator = null;
  }

  /** 设置审批事件出口（主进程 IPC 调用） */
  setEventSink(sink: ((ev: unknown) => void) | null): void {
    this.eventSink = sink;
  }

  /** 渲染层响应审批 */
  respondApproval(id: string, approved: boolean): void {
    this.pendingApprovals.get(id)?.(approved);
    this.pendingApprovals.delete(id);
  }

  /** 渲染层响应澄清（用户点选选项或自定义输入） */
  respondClarification(id: string, answer: string): void {
    this.pendingClarifications.get(id)?.(answer);
    this.pendingClarifications.delete(id);
  }

  /**
   * 向用户提问并等待回答：发澄清事件给渲染层，用户响应后返回答案。
   * 超时（60s）返回空串，由调用方兜底，避免任务卡死。
   */
  private async requestClarification(context: {
    question: string;
    options: string[];
    allowCustom: boolean;
  }): Promise<string> {
    if (!this.eventSink) return '';
    const id = randomUUID();
    const answer = await new Promise<string>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: string) => {
        if (timer) clearTimeout(timer);
        this.pendingClarifications.delete(id);
        resolve(value);
      };
      timer = setTimeout(() => settle(''), 60_000); // 用户不响应则超时，模型自行继续
      timer.unref?.();
      this.pendingClarifications.set(id, settle);
      this.eventSink!({
        type: 'clarification_request',
        id,
        question: context.question,
        options: context.options,
        allowCustom: context.allowCustom,
      });
    });
    return answer;
  }

  /** 撤销最近一轮的文件改动 */
  undoLastRun(): { restored: string[]; failed: string[] } {
    const result = restoreChanges(this.workspaceRoots, this.changes);
    this.changes = [];
    return result;
  }

  /** 云端模式：把客户端收集的本轮改动回传给渲染层 */
  getChanges(): FileChange[] {
    return [...this.changes];
  }

  /** 新一轮开始前清空改动收集 */
  resetChanges(): void {
    this.changes = [];
    this.pendingEdits.clear();
  }

  getState(): { state: RunState; checkpoint: RunCheckpoint | null } {
    return { state: this.runState, checkpoint: this.store.get() };
  }

  /** 暂停当前运行：中断模型请求，保存检查点 */
  pause(): { state: RunState; checkpoint: RunCheckpoint | null } {
    if (this.runState === 'running') {
      this.pausing = true;
      this.currentAbort?.abort();
    }
    return this.getState();
  }

  /** 取消当前运行：中断模型请求，检查点保留可继续 */
  cancel(): { state: RunState; checkpoint: RunCheckpoint | null } {
    if (this.runState === 'running') {
      this.cancelling = true;
      this.currentAbort?.abort();
    }
    return this.getState();
  }

  /** 从检查点继续：用保存的历史和原始任务重跑 */
  async *resume(): AsyncGenerator<AgentEvent> {
    const checkpoint = this.store.get();
    if (!checkpoint || this.runState !== 'paused') return;
    this.resumeFrom = checkpoint;
    this.checkpointId = checkpoint.id;
    yield* this.run(
      '继续执行之前的任务。',
      new AbortController().signal,
      checkpoint.history,
      checkpoint.context,
    );
  }

  private needsApproval(name: string, args: Record<string, unknown>): boolean {
    const cfg = getConfig();
    // 文件操作（写/删/移动）：fileApproval=ask 时走 pending diff 审批
    // （改动先不落盘，用户在消息里确认），不再重复弹审批框
    const fileTools = [
      'write_file',
      'edit_file',
      'apply_patch',
      'delete_file',
      'move_file',
    ];
    if (fileTools.includes(name)) {
      return false;
    }
    // 命令执行 / 接口调试：由「命令执行审批」开关控制（仅危险命令）
    if (name === 'run_terminal') {
      if (cfg.commandApproval === 'auto') return false;
      return RISKY_COMMAND.test(String(args.command ?? ''));
    }
    if (name === 'http_request') {
      return cfg.commandApproval !== 'auto';
    }
    // MCP 工具可能有副作用：按命令执行审批处理
    if (name.startsWith('mcp_')) {
      return cfg.commandApproval !== 'auto';
    }
    // 数据库写操作：由「数据库操作审批」开关控制
    if (name === 'execute_sql') {
      return cfg.databaseApproval !== 'auto';
    }
    return false;
  }

  private async requestApproval(context: {
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<boolean> {
    if (!this.eventSink) return true; // 没有 UI：保持旧行为，自动放行
    const id = randomUUID();
    const approved = await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: boolean) => {
        if (timer) clearTimeout(timer);
        this.pendingApprovals.delete(id);
        resolve(value);
      };
      timer = setTimeout(() => settle(false), 60_000); // 用户不响应则超时拒绝
      timer.unref?.();
      this.pendingApprovals.set(id, settle);
      this.eventSink!({
        type: 'approval_request',
        id,
        toolName: context.toolName,
        args: context.args,
        preview: previewApproval(
          this.workspaceRoots,
          context.toolName,
          context.args,
        ),
      });
    });
    return approved;
  }

  /** 云端模式：后端把工具调用转回来，由主进程在本地执行 */
  async execTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    // 澄清工具：走 UI 提问（云端模式下后端不配澄清钩子，ask_user 会经
    // tool_request 转到这里），等用户点选/输入后把答案作为工具结果回传
    if (name === 'ask_user') {
      const answer = await this.requestClarification({
        question: String(args.question ?? ''),
        options: Array.isArray(args.options)
          ? args.options.map((o) => String(o))
          : [],
        allowCustom: args.allowCustom !== false,
      });
      return `用户的选择：${answer}`;
    }
    const agent = this.ensureAgent();
    const tool = agent.tools.find(
      (t) => t.definition.function.name === name,
    );
    if (!tool) return `未知工具：${name}`;

    // 云端代理执行也走同一套审批策略
    const policy = agent.approvalPolicy?.(name, args) ?? 'allow';
    if (policy === 'deny') return `工具被策略拒绝：${name}`;
    if (policy === 'ask') {
      const approved = await this.requestApproval({ toolName: name, args });
      if (!approved) return `用户拒绝执行：${name}`;
    }

    return await tool.handler(args, {
      toolName: name,
      artifacts: this.execArtifacts,
    });
  }

  private rebuildAgent(): void {
    if (!this.workspaceRoots.length) {
      this.agent = null;
      return;
    }
    this.deferWrite = getConfig().fileApproval === 'ask';
    const base = createEditorAgent(
      this.workspaceRoots,
      (change) => this.changes.push(change),
      {
        onBrowserOpen: (url) =>
          this.eventSink?.({ type: 'browser_open', url }),
        // 文件操作审批开启时：改动不直接落盘，产出 pending diff 等用户确认
        deferWrite: this.deferWrite,
        // pending 改动还没写入磁盘，自动验证会读到旧内容，直接关掉
        verifier: this.deferWrite ? null : undefined,
        // 数据库执行器：本地模式直接可用；云端模式由 tool_request 回到这里执行
        database: getDatabaseManager().getRunner(),
        // 同一轮内多次编辑同一文件时，后续编辑基于未落盘内容计算
        pendingEdits: this.pendingEdits,
      },
    );
    // MCP 工具动态注入；同名时保留内置工具
    const builtinNames = new Set(
      base.tools.map((t) => t.definition.function.name),
    );
    const mcpTools = mcpManager
      .getTools()
      .filter((t) => !builtinNames.has(t.definition.function.name));
    const approvalPolicy: ApprovalPolicy = (name, args) =>
      this.needsApproval(name, args) ? 'ask' : 'allow';
    const requestApproval: ApprovalHook = (context) =>
      this.requestApproval(context);
    const requestClarification: ClarificationHook = (context) =>
      this.requestClarification(context);
    this.agent = {
      ...base,
      tools: [...base.tools, ...mcpTools],
      approvalPolicy,
      requestApproval,
      requestClarification,
    };
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
        // 模型空响应时自动追问，避免多步任务半路停住
        emptyRetryLimit: 2,
      });
    }
    return this.orchestrator;
  }

  async *run(
    query: string,
    signal: AbortSignal,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    context?: AgentPromptContext,
    images: string[] = [],
  ): AsyncGenerator<AgentEvent> {
    const agent = this.ensureAgent();
    const orchestrator = this.ensureOrchestrator();
    if (!this.resumeFrom) {
      this.changes = [];
      this.pendingEdits.clear();
    }

    const complexity = classifyComplexity({
      userQuery: query,
      hasImages: images.length > 0,
    });
    const candidates = resolveModelCandidates(
      complexity,
      // 本地编辑器用设置里选的固定模型，不参与问答链路的首选模型调度
      { ...orchestrator.modelConfig, priorityModel: '' },
      { zhipuAvailable: orchestrator.zhipuAvailable },
    );

    // 编辑器是固定模型（用户在设置里选的），只提示当前使用的模型与循环上限；
    // 编排器内部的降级提示仍会照常输出。
    if (candidates.length) {
      const rounds = agent.maxToolRounds;
      yield {
        type: 'thought',
        content: `当前模型：${candidates[0].model}${
          rounds ? ` · 循环上限：${rounds} 轮` : ''
        }`,
      };
    }

    // 图片以多模态内容随本轮 user 消息发送（历史消息只保留文本）
    const userMessage: Record<string, unknown> = images.length
      ? {
          role: 'user',
          content: [
            { type: 'text', text: query },
            ...images.map((url) => ({
              type: 'image_url',
              image_url: { url },
            })),
          ],
        }
      : { role: 'user', content: query };

    const messages: Array<Record<string, unknown>> = [
      {
        role: 'system',
        content: agent.buildSystemPrompt({ query, context }),
      },
      ...history
        .filter((m) => typeof m.content === 'string' && m.content.trim())
        .slice(-20),
      userMessage,
    ];

    this.currentAbort = new AbortController();
    const runSignal = signal
      ? AbortSignal.any([signal, this.currentAbort.signal])
      : this.currentAbort.signal;
    this.runState = 'running';

    try {
      for await (const ev of orchestrator.run({
        messages,
        tools: agent.tools,
        candidates,
        complexity,
        verifyAfterTools: agent.verifyAfterTools,
        editToolNames: agent.editToolNames,
        // 编辑器任务链路长，用 agent 自带的分级循环上限（15 轮）
        maxToolRounds: agent.maxToolRounds,
        approvalPolicy: agent.approvalPolicy,
        requestApproval: agent.requestApproval,
        signal: runSignal,
      })) {
        // 把本轮文件改动挂到 done 事件上，渲染层据此展示 diff；
        // file_edit 事件原样透传，供编辑器做流式动画
        if (ev.type === 'done') {
          yield { ...ev, changes: this.changes };
        } else {
          yield ev;
        }
      }

      if (this.pausing) {
        this.runState = 'paused';
        const checkpointHistory = this.resumeFrom
          ? history
          : [...history, { role: 'user' as const, content: query }];
        this.store.set({
          id: this.checkpointId,
          query: this.resumeFrom?.query ?? query,
          history: checkpointHistory,
          context,
          changes: this.changes,
          state: 'paused',
          updatedAt: Date.now(),
        });
      } else if (this.cancelling) {
        this.runState = 'cancelled';
      } else if (runSignal.aborted) {
        this.runState = 'cancelled';
      } else {
        this.runState = 'done';
      }
    } catch (error) {
      this.runState = 'failed';
      throw error;
    } finally {
      this.pausing = false;
      this.cancelling = false;
      this.currentAbort = null;
      this.resumeFrom = null;
    }
  }
}
