import {
  AgentOrchestrator,
  classifyComplexity,
  formatRoutingThought,
  providerForModel,
  resolveModelCandidates,
  type AgentEvent,
  type AgentPromptContext,
  type RegisteredTool,
} from '@repo/agent-orchestrator';
import type { AgentDefinition } from './types.js';

export interface AgentRunInput {
  query: string;
  /** 历史消息（不含本轮 user），由宿主从库里取 */
  history?: Array<Record<string, unknown>>;
  signal?: AbortSignal;
  /** 客户端指定的模型；设置后覆盖后端级联 */
  modelOverride?: string;
  /** 覆盖 agent 的工具集（云端模式用「代理工具」把执行转给客户端） */
  toolsOverride?: RegisteredTool[];
  /** 覆盖系统提示（云端模式用客户端的本地工作区根目录） */
  systemPromptOverride?: string;
  /** 关闭 agent 定义的自动验证（云端代理模式：客户端通过 verify_workspace 验证） */
  disableAutoVerify?: boolean;
  /** 编辑器上下文（active file / 选区） */
  context?: AgentPromptContext;
  /** 本轮附带的图片（base64 data URL） */
  images?: string[];
}

/**
 * 把一个 AgentDefinition 跑起来：
 * 组装消息 → 推导候选链 → 推送路由思考 → 交给共享编排器。
 *
 * 各 agent 只提供工具集和系统提示，循环完全复用同一个编排器。
 */
export class AgentRunner {
  constructor(private readonly orchestrator: AgentOrchestrator) {}

  async *run(
    agent: AgentDefinition,
    input: AgentRunInput,
  ): AsyncGenerator<AgentEvent> {
    // 图片以多模态内容随本轮 user 消息发送（历史消息只保留文本）
    const userMessage: Record<string, unknown> = input.images?.length
      ? {
          role: 'user',
          content: [
            { type: 'text', text: input.query },
            ...input.images.map((url) => ({
              type: 'image_url',
              image_url: { url },
            })),
          ],
        }
      : { role: 'user', content: input.query };

    const messages: Array<Record<string, unknown>> = [
      {
        role: 'system',
        content:
          input.systemPromptOverride ??
          agent.buildSystemPrompt({
            query: input.query,
            context: input.context,
          }),
      },
      ...(input.history ?? []),
      userMessage,
    ];

    const complexity = classifyComplexity({
      userQuery: input.query,
      hasImages: Boolean(input.images?.length),
    });
    const candidates = input.modelOverride
      ? [
          {
            provider: providerForModel(input.modelOverride),
            model: input.modelOverride,
          },
        ]
      : resolveModelCandidates(complexity, this.orchestrator.modelConfig, {
          zhipuAvailable: this.orchestrator.zhipuAvailable,
        });

    // 编辑器是固定模型（用户选定），只提示当前使用的模型与循环上限；
    // 其他 agent（如问答）保留完整的模型选择路由思考。
    if (candidates.length && agent.id === 'editor') {
      const rounds = agent.maxToolRounds;
      yield {
        type: 'thought',
        content: `当前模型：${candidates[0].model}${
          rounds ? ` · 循环上限：${rounds} 轮` : ''
        }`,
      };
    } else if (this.orchestrator.showRoutingThought && candidates.length) {
      yield {
        type: 'thought',
        content: formatRoutingThought(
          complexity,
          candidates,
          this.orchestrator.modelConfig,
        ),
      };
    }

    yield* this.orchestrator.run({
      messages,
      tools: input.toolsOverride ?? agent.tools,
      candidates,
      complexity,
      includeTools: agent.includeTools ?? true,
      verifyAfterTools: input.disableAutoVerify
        ? undefined
        : agent.verifyAfterTools,
      editToolNames: agent.editToolNames,
      // agent 自带有分级循环上限（编辑器 15 轮），未配置时用编排器默认值
      maxToolRounds: agent.maxToolRounds,
      approvalPolicy: agent.approvalPolicy,
      requestApproval: agent.requestApproval,
      signal: input.signal,
    });
  }
}
