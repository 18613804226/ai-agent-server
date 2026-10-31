import OpenAI from 'openai';
import {
  errorMessage,
  errorStatus,
  isDegradableError,
  isRateLimitError,
  resolveModelCandidates,
  zhipuThinkingParam,
  type ModelCascadeConfig,
  type ModelCandidate,
} from './model-cascade.js';
import {
  finalizeToolCalls,
  mergeToolCallDeltas,
  type ToolCallAccumulator,
} from './tool-call-accumulator.js';
import { SimpleLock } from './simple-lock.js';
import type { AgentEvent, AgentInput, ContentGate, FileEdit } from './types.js';

/** 编排器配置：全部由宿主注入，编排器自身不读 process.env */
export interface OrchestratorConfig {
  /**
   * 按 provider 取客户端。用函数而非实例，便于宿主在运行期替换
   * （测试里替换 mock 客户端即可生效），也避免编排器持有过期引用。
   */
  getClient: (provider: ModelCandidate['provider']) => OpenAI | null;
  /** 模型级联配置（档位、阈值） */
  modelConfig: ModelCascadeConfig;
  /** 是否把模型路由决策作为 thought 推出 */
  showRoutingThought: boolean;
  /** 免费层 429 限流时的原地重试次数 */
  rateLimitRetries: number;
  /** 智谱免费层单并发锁 */
  zhipuLock: SimpleLock;
  /** 默认最大工具轮数 */
  defaultMaxRounds?: number;
}

/**
 * Agent 编排器：模型级联建流 + 流式工具调用循环。
 *
 * 只做编排，不碰持久化、RAG、文件系统；宿主通过 AgentEvent 消费结果，
 * 通过 ContentGate 注入「拒答守卫」这类场景逻辑。
 */
export class AgentOrchestrator {
  constructor(private readonly config: OrchestratorConfig) {}

  /** 模型级联配置（供宿主推导候选链、生成路由思考） */
  get modelConfig(): ModelCascadeConfig {
    return this.config.modelConfig;
  }

  /** 是否推送路由思考 */
  get showRoutingThought(): boolean {
    return this.config.showRoutingThought;
  }

  /** 智谱免费层是否可用 */
  get zhipuAvailable(): boolean {
    return !!this.config.getClient('zhipu');
  }

  /** 取对应 provider 的客户端；未配置返回 null，候选会被跳过 */
  private clientFor(provider: ModelCandidate['provider']): OpenAI | null {
    return this.config.getClient(provider);
  }

  /**
   * 建流式请求，按候选链降级。
   *  - 429 限流：先原地退避重试，仍失败才降级，避免一遇限流就切付费模型白花钱。
   *  - 智谱免费层限 1 并发：zhipu 候选加全局锁串行，锁一直持有到流读完。
   *  - 只在「建连阶段」降级：一旦开始吐字就不再换模型，避免把重复内容推给客户端。
   */
  private async createChatStream(
    candidates: ModelCandidate[],
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    onThought?: (text: string) => void,
  ): Promise<{
    stream: any;
    candidate: ModelCandidate;
    release?: () => void;
  }> {
    let lastError: any = null;
    for (const candidate of candidates) {
      const client = this.clientFor(candidate.provider);
      if (!client) continue;

      const release =
        candidate.provider === 'zhipu'
          ? await this.config.zhipuLock.acquire()
          : undefined;

      const maxTries = this.config.rateLimitRetries + 1;
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
          // 智谱：默认关思考链（首字从 50s+ 降到秒级）；qwen 不适用该参数
          const body =
            candidate.provider === 'zhipu'
              ? { ...payload, model: candidate.model, ...zhipuThinkingParam() }
              : { ...payload, model: candidate.model };
          const stream = await client.chat.completions.create(body as any, {
            signal,
          });
          // 锁交给调用方：流读完再释放，保证全程只有 1 个智谱请求在飞
          return { stream, candidate, release };
        } catch (err: any) {
          if (signal?.aborted) {
            release?.();
            throw err;
          }
          lastError = err;
          const status = errorStatus(err);
          const serverMsg = errorMessage(err);
          const rateLimited = isRateLimitError(err);
          const canRetry = rateLimited && attempt < maxTries;

          console.warn(
            `🧠 [模型分层] ${candidate.provider}:${candidate.model} 建流失败，` +
              `状态=${status ?? '-'}${serverMsg ? ` ${serverMsg}` : ''}，` +
              `${canRetry ? `限流，${800 * attempt}ms 后原地重试(${attempt}/${maxTries - 1})` : '切换到下一个候选'}`,
          );

          if (canRetry) {
            onThought?.(
              `免费层请求繁忙，稍后重试（第 ${attempt}/${maxTries - 1} 次）…`,
            );
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }

          onThought?.(
            `首选模型 ${candidate.model} 暂时不可用，正在切换备用模型…`,
          );
          // isDegradableError 目前恒真（除客户端断开），保留判断便于日后收紧策略
          if (!isDegradableError(err)) {
            release?.();
            throw err;
          }
          release?.(); // 放弃这个候选，放锁再试下一个
          break;
        }
      }
    }
    throw lastError;
  }

  /** 候选链缺省时按复杂度推导 */
  private deriveCandidates(input: AgentInput): ModelCandidate[] {
    if (!input.complexity) return [];
    return resolveModelCandidates(input.complexity, this.config.modelConfig, {
      zhipuAvailable: !!this.config.getClient('zhipu'),
    });
  }

  /**
   * 跑一轮完整的 agent 循环：建流 → 累积 tool_calls → 执行工具 → 回填 → 再跑一轮，
   * 直到不再调工具或达到最大轮数。通过 AsyncGenerator 吐出 AgentEvent。
   */
  async *run(input: AgentInput, gate?: ContentGate): AsyncGenerator<AgentEvent> {
    const {
      messages,
      tools = [],
      maxToolRounds = this.config.defaultMaxRounds ?? 4,
      signal,
      includeTools = true,
    } = input;

    let chain = input.candidates ?? this.deriveCandidates(input);
    let usedModel = '';
    let usedTokens = 0;
    let rawFullReply = '';
    let refusalRetried = false;

    if (!chain.length) {
      yield { type: 'error', content: '没有可用的模型候选' };
      return;
    }

    for (let round = 0; round <= maxToolRounds; round++) {
      if (signal?.aborted) return;

      const streamStartTime = Date.now();
      const toolAcc: ToolCallAccumulator = {};
      let roundReply = '';
      let roundTtft: number | null = null;
      // 拒答守卫：gateOpen=false 时内容先攒在 gateBuf，够长或确认非拒答才放行
      let gateOpen = !gate?.enabled;
      let gateBuf = '';

      const payload = {
        messages,
        stream: true,
        tools: includeTools
          ? tools.map((t) => t.definition)
          : undefined,
        tool_choice: includeTools ? 'auto' : undefined,
        stream_options: { include_usage: true },
      };
      const pendingThoughts: string[] = [];
      const { stream, candidate, release } = await this.createChatStream(
        chain,
        payload,
        signal,
        this.config.showRoutingThought
          ? (t) => pendingThoughts.push(t)
          : undefined,
      );
      usedModel = `${candidate.provider}:${candidate.model}`;
      // 建流阶段的路径决策（限流重试、切换候选）先于内容吐出
      for (const t of pendingThoughts) yield { type: 'thought', content: t };

      try {
        for await (const chunk of stream) {
          if (signal?.aborted) {
            console.log('检测到用户中断，强行跳出大模型流生成。');
            break;
          }

          if (roundTtft === null) roundTtft = Date.now() - streamStartTime;

          // stream_options.include_usage 的用量只在最后一个 chunk 下发，累加起来
          const chunkUsage = (chunk as any).usage;
          if (chunkUsage?.total_tokens) {
            usedTokens += chunkUsage.total_tokens;
          }

          const delta =
            (chunk as any).choices?.[0]?.delta ||
            (chunk as any).message ||
            {};

          if (delta.tool_calls?.length) {
            mergeToolCallDeltas(toolAcc, delta.tool_calls);
          }

          const reasoningContent =
            delta.reasoning_content ||
            delta.reasoning ||
            delta.thought ||
            (chunk as any).reasoning_content ||
            (chunk as any).thought ||
            (chunk as any).reasoning ||
            '';

          const textContent =
            delta.content ||
            delta.text ||
            delta.message ||
            (chunk as any).content ||
            (chunk as any).text ||
            (typeof chunk === 'string' ? chunk : '');

          if (!textContent && !reasoningContent) continue;

          if (reasoningContent) {
            yield { type: 'thought', content: reasoningContent };
          }

          if (textContent) {
            roundReply += textContent;
            if (gateOpen) {
              rawFullReply += textContent;
              yield { type: 'content', content: textContent };
            } else {
              gateBuf += textContent;
              // 攒够阈值仍未见拒答 → 放行已攒内容，之后正常流式
              if (gateBuf.length >= (gate?.threshold ?? 120)) {
                gateOpen = true;
                rawFullReply += gateBuf;
                yield { type: 'content', content: gateBuf };
              }
            }
          }
        }
      } finally {
        // 智谱锁：必须等整条流读完才放，避免并发打爆免费层的 1 并发限制
        release?.();
      }

      const toolCalls = finalizeToolCalls(toolAcc);

      // 命中拒答：换候选链重试本轮
      if (
        gate?.enabled &&
        !gateOpen &&
        !refusalRetried &&
        !toolCalls.length &&
        gate.isRefusal(roundReply)
      ) {
        refusalRetried = true;
        const next = gate.nextCandidates(chain);
        if (next && next.length) {
          console.warn(
            `🧠 [模型分层] ${candidate.provider}:${candidate.model} 疑似拒答，` +
              `换 ${next[0].provider}:${next[0].model} 重试`,
          );
          chain = next;
          yield { type: 'thought', content: '正在切换备用模型…' };
          round--; // 重试同一轮
          continue;
        }
        // 没有可用备用模型 → 退化为把内容正常发出
        gateOpen = true;
        if (gateBuf) {
          rawFullReply += gateBuf;
          yield { type: 'content', content: gateBuf };
        }
      } else if (!gateOpen) {
        // 未命中拒答（或正常短回答）→ 放行扣住的内容
        gateOpen = true;
        if (gateBuf) {
          rawFullReply += gateBuf;
          yield { type: 'content', content: gateBuf };
        }
      }

      // 没有工具要调 → 这一轮就是最终回答
      if (!toolCalls.length) break;
      if (signal?.aborted) return;

      // 有工具要调：把 assistant(tool_calls) 与执行结果追加进上下文，再来一轮流式
      messages.push({
        role: 'assistant',
        content: roundReply || null,
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        if (signal?.aborted) return;
        // 先解析入参：tool_call 事件要带上 args，让宿主能展示「读/写/编辑哪个文件」
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }
        yield { type: 'tool_call', name: call.function.name, args };

        const handler = tools.find(
          (t) => t.definition.function.name === call.function.name,
        )?.handler;
        let result: string;
        try {
          // 文件编辑类工具：在真正执行前把编辑意图吐给宿主，做「一行一行往下刷」的动画
          const edit = parseFileEdit(call.function.name, args);
          if (edit) yield { type: 'file_edit', edit };
          result = handler
            ? await handler(args)
            : `未知工具：${call.function.name}`;
        } catch (e: any) {
          result = `工具执行出错：${e.message}`;
        }
        yield { type: 'tool_result', name: call.function.name, result };
        messages.push({
          tool_call_id: call.id,
          role: 'tool',
          name: call.function.name,
          content: result,
        });
      }
    }

    const fullReply = rawFullReply
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<\/?think>/g, '')
      .replace(/<\/?tool_call>/g, '')
      .trimStart();

    yield { type: 'done', model: usedModel, tokens: usedTokens, fullReply };
  }
}

/**
 * 把文件编辑类工具的入参解析成 FileEdit 意图。
 * 只识别编辑器包里的写操作工具，其余返回 undefined（不触发 file_edit 事件）。
 *
 * 注意：这里只做「意图解析」，不读文件系统——before/after 由工具在执行时自己产出，
 * 编排器不关心文件内容，保持编排层与持久化层解耦。
 */
function parseFileEdit(
  toolName: string,
  args: Record<string, unknown>,
): FileEdit | undefined {
  switch (toolName) {
    case 'write_file':
      return {
        path: String(args.path ?? ''),
        kind: 'create',
        after: String(args.content ?? ''),
      };
    case 'edit_file':
      return {
        path: String(args.path ?? ''),
        kind: 'modify',
        old_string: String(args.old_string ?? ''),
        new_string: String(args.new_string ?? ''),
      };
    case 'apply_patch': {
      const edits = Array.isArray(args.edits) ? (args.edits as any[]) : [];
      if (!edits.length) return undefined;
      const first = edits[0];
      const path = String(first?.path ?? '');
      if (typeof first?.content === 'string') {
        return { path, kind: 'create', after: first.content };
      }
      return {
        path,
        kind: 'modify',
        old_string: String(first?.old_string ?? ''),
        new_string: String(first?.new_string ?? ''),
      };
    }
    case 'delete_file':
      return { path: String(args.path ?? ''), kind: 'delete' };
    case 'move_file':
      return {
        path: String(args.to ?? ''),
        kind: 'rename',
        from: String(args.from ?? ''),
        to: String(args.to ?? ''),
      };
    default:
      return undefined;
  }
}
