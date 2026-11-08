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
  type AccumulatedToolCall,
  type ToolCallAccumulator,
} from './tool-call-accumulator.js';
import { SimpleLock } from './simple-lock.js';
import { withIdleTimeout, withTimeout } from './async-utils.js';
import { ToolRuntime, validateToolArgs } from './tool-runtime.js';
import { ArtifactStore } from './artifact-store.js';
import {
  ContextManager,
  type ContextManagerOptions,
} from './context-manager.js';
import type {
  AgentEvent,
  AgentInput,
  ApprovalHook,
  ApprovalPolicy,
  ContentGate,
  ContextStats,
  FileEdit,
  RegisteredTool,
} from './types.js';

/**
 * 流式内容清洗：剥掉模型偶尔吐出的 XML 风格「伪工具」标签
 * （`<think>…</think>`、`<tool_call>…</tool_call>`、`<web_search>…</web_search>`）。
 *
 * 这些标签是模型把「推理/调用」误写进正文的产物，用户不需要看到。
 * 用有状态的扫描器按 chunk 增量处理：进入已知标签区间就抑制输出，
 * 直到看到对应闭合标签为止；标签本身（开/闭）也一并吞掉。
 */
const SUPPRESSED_TAGS = new Set(['think', 'tool_call', 'web_search']);

export function createContentSanitizer() {
  /** 当前被抑制的标签名（小写），null 表示不在任何标签内 */
  let inside: string | null = null;
  /** 跨 chunk 的未闭合标签缓冲（如 `<thi` + `nk>`） */
  let pending = '';

  return (chunk: string): string => {
    let buffer = pending + chunk;
    pending = '';
    let out = '';

    while (buffer.length > 0) {
      if (inside) {
        // 在抑制区内：找闭合标签
        const closeIdx = buffer.toLowerCase().indexOf(`</${inside}`);
        if (closeIdx === -1) {
          // 还没找到闭合 → 整段丢弃，但保留可能是闭合前缀的尾巴
          const tail = Math.max(0, buffer.length - inside.length - 3);
          buffer = buffer.slice(tail);
          pending = buffer;
          break;
        }
        // 跳过闭合标签本身
        const afterClose = buffer.indexOf('>', closeIdx);
        if (afterClose === -1) {
          pending = buffer.slice(closeIdx);
          break;
        }
        buffer = buffer.slice(afterClose + 1);
        inside = null;
        continue;
      }

      // 不在抑制区：找下一个 '<'
      const lt = buffer.indexOf('<');
      if (lt === -1) {
        out += buffer;
        buffer = '';
        break;
      }
      out += buffer.slice(0, lt);

      // 解析标签名
      const rest = buffer.slice(lt);
      const m = /^<\s*(\/?)\s*([A-Za-z_][\w-]*)/.exec(rest);
      if (!m) {
        // 不是合法标签（比如数学式 1 < 2），原样输出 '<'
        out += '<';
        buffer = rest.slice(1);
        continue;
      }
      const [, slash, name] = m;
      const lower = name.toLowerCase();
      if (!SUPPRESSED_TAGS.has(lower)) {
        // 非目标标签：原样吐出，继续扫描
        out += rest.slice(0, m[0].length);
        buffer = rest.slice(m[0].length);
        continue;
      }
      if (slash) {
        // 闭合标签但不处于抑制区 → 直接吞掉
        buffer = rest.slice(m[0].length);
        continue;
      }
      // 进入抑制区
      inside = lower;
      buffer = rest.slice(m[0].length);
    }

    return out;
  };
}

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
  /** 模型空响应（没说话也没调工具）时的最多追问重试次数；0/undefined 关闭 */
  emptyRetryLimit?: number;
  /** 模型建连超时（ms），默认 60s */
  connectTimeoutMs?: number;
  /** 流式空闲超时（ms），默认 90s；两个 chunk 之间无数据即中止 */
  streamIdleTimeoutMs?: number;
  /** 智谱锁等待超时（ms），默认 30s；拿不到锁就降级到下一个候选 */
  lockAcquireTimeoutMs?: number;
  /** 单次工具执行超时（ms），默认 120s */
  toolTimeoutMs?: number;
  /** 工具结果最大字符数，默认 8000 */
  toolMaxResultChars?: number;
  /** 上下文压缩策略 */
  contextOptions?: ContextManagerOptions;
}

/** 默认会触发自动验证的编辑类工具 */
const DEFAULT_EDIT_TOOL_NAMES = [
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'move_file',
];

/** 验证结果回填前统一截断，避免长 lint 输出撑爆上下文 */
function capVerdict(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（验证输出已截断）`;
}

/**
 * Agent 编排器：模型级联建流 + 流式工具调用循环。
 *
 * 只做编排，不碰持久化、RAG、文件系统；宿主通过 AgentEvent 消费结果，
 * 通过 ContentGate 注入「拒答守卫」这类场景逻辑。
 */
export class AgentOrchestrator {
  private readonly connectTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly lockAcquireTimeoutMs: number;
  private readonly toolRuntime: ToolRuntime;
  private readonly contextManager: ContextManager;

  constructor(private readonly config: OrchestratorConfig) {
    this.connectTimeoutMs = config.connectTimeoutMs ?? 60_000;
    this.streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 90_000;
    this.lockAcquireTimeoutMs = config.lockAcquireTimeoutMs ?? 30_000;
    this.toolRuntime = new ToolRuntime({
      timeoutMs: config.toolTimeoutMs,
      maxResultChars: config.toolMaxResultChars,
    });
    this.contextManager = new ContextManager(config.contextOptions);
  }

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
    /** 由宿主按场景注入，只对智谱候选生效 */
    sampling?: { temperature?: number; top_p?: number; max_tokens?: number },
  ): Promise<{
    stream: any;
    candidate: ModelCandidate;
    release?: () => void;
    /** 中止底层请求并解绑 signal；调用方在流结束后必须调用 */
    dispose: () => void;
  }> {
    let lastError: any = null;
    let attempted = 0;

    for (const candidate of candidates) {
      const client = this.clientFor(candidate.provider);
      if (!client) continue;

      attempted++;
      let release: (() => void) | undefined;
      try {
        release =
          candidate.provider === 'zhipu'
            ? await this.config.zhipuLock.acquire(this.lockAcquireTimeoutMs)
            : undefined;
      } catch (err: any) {
        // 锁等待超时：不阻塞在这里，直接降级到下一个候选
        lastError = err;
        onThought?.(`${candidate.model} 并发已满，切换备用模型…`);
        console.warn(
          `🧠 [模型分层] ${candidate.provider}:${candidate.model} 获取并发锁超时，切换下一个候选`,
        );
        continue;
      }

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const dispose = () => {
        controller.abort();
        signal?.removeEventListener('abort', onAbort);
      };

      const maxTries = this.config.rateLimitRetries + 1;
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
          // thinking 是智谱私有参数，只给智谱；temperature/top_p/max_tokens 各平台通用，
          // 首选换成 qwen 后四档采样（含情绪档）仍要生效，所以对所有候选都下发。
          const body = {
            ...payload,
            model: candidate.model,
            ...(candidate.provider === 'zhipu' ? zhipuThinkingParam() : {}),
            ...sampling,
          };
          const stream = await withTimeout(
            client.chat.completions.create(body as any, {
              signal: controller.signal,
            }),
            this.connectTimeoutMs,
            controller.signal,
            `模型建连超时（${candidate.model}，${this.connectTimeoutMs}ms）`,
          );
          // 锁交给调用方：流读完再释放，保证全程只有 1 个智谱请求在飞
          return { stream, candidate, release, dispose };
        } catch (err: any) {
          if (signal?.aborted) {
            dispose();
            release?.();
            throw err;
          }
          lastError = err;
          const status = errorStatus(err);
          const serverMsg = errorMessage(err);
          const rateLimited = isRateLimitError(err);
          // 首选模型有次数限制：429 基本等于配额用尽，原地重试没意义，
          // 直接切下一个候选，省掉退避等待（其余候选仍按原逻辑重试）。
          const isPriorityModel =
            !!this.config.modelConfig.priorityModel &&
            candidate.model === this.config.modelConfig.priorityModel;
          const canRetry = rateLimited && attempt < maxTries && !isPriorityModel;

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

          // 只有真正排在链首的首选模型才这么称呼，普通候选失败不要误报
          const label = isPriorityModel ? '首选模型' : '模型';
          onThought?.(
            `${label} ${candidate.model} 暂时不可用，正在切换备用模型…`,
          );
          // 401/403/402 这类配置错误不降级，避免白试所有候选
          if (!isDegradableError(err)) {
            dispose();
            release?.();
            throw err;
          }
          dispose(); // 中止可能挂着的底层请求
          release?.(); // 放弃这个候选，放锁再试下一个
          break;
        }
      }
    }

    if (lastError) throw lastError;
    throw new Error(
      attempted
        ? '所有模型候选均请求失败'
        : '没有可用的模型客户端（请检查 provider 配置）',
    );
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
  /**
   * 执行单个工具调用（不吐事件）：审批 → 参数校验 → 重复调用缓存 → ToolRuntime。
   * 只读工具的结果会进缓存；重复调用返回引用而不是全文。
   */
  private async executeToolCall(
    call: AccumulatedToolCall,
    args: Record<string, unknown>,
    context: {
      signal?: AbortSignal;
      approvalPolicy?: ApprovalPolicy;
      requestApproval?: ApprovalHook;
      tools: RegisteredTool[];
      artifacts?: ArtifactStore;
      resultCache: Map<string, string>;
      preApproved?: boolean;
    },
  ): Promise<string> {
    const tool = context.tools.find(
      (t) => t.definition.function.name === call.function.name,
    );
    const policy = context.approvalPolicy?.(call.function.name, args) ?? 'allow';
    let approved = policy !== 'deny';
    if (approved && policy === 'ask') {
      if (context.preApproved) {
        approved = true; // 已在 file_edit 之前审批过，跳过重复审批
      } else if (context.signal?.aborted) {
        approved = false;
      } else if (context.requestApproval) {
        approved = await context.requestApproval({
          toolName: call.function.name,
          args,
          signal: context.signal,
        });
      } else {
        approved = false; // 配置为 ask 但没有审批钩子：安全起见拒绝
      }
    }
    if (!approved) {
      return policy === 'deny'
        ? `工具被策略拒绝：${call.function.name}`
        : `用户拒绝执行：${call.function.name}`;
    }
    if (!tool) return `未知工具：${call.function.name}`;

    const invalid = validateToolArgs(tool.definition, args);
    if (invalid) return `工具参数错误（${call.function.name}）：${invalid}`;

    const key = `${call.function.name}:${JSON.stringify(args)}`;
    if (tool.readOnly) {
      const cached = context.resultCache.get(key);
      if (cached !== undefined) {
        return `【重复调用】与之前相同，结果已省略（原长 ${cached.length} 字符）。如需完整内容请重新读取。`;
      }
    }

    const result = await this.toolRuntime.execute(tool, args, {
      signal: context.signal,
      toolName: call.function.name,
      artifacts: context.artifacts,
    });
    if (tool.readOnly) context.resultCache.set(key, result);
    return result;
  }

  async *run(input: AgentInput, gate?: ContentGate): AsyncGenerator<AgentEvent> {
    const {
      messages,
      tools = [],
      maxToolRounds = this.config.defaultMaxRounds ?? 4,
      signal,
      includeTools = true,
      verifyAfterTools,
      editToolNames,
      approvalPolicy,
      requestApproval,
      sampling,
    } = input;

    let chain = input.candidates ?? this.deriveCandidates(input);
    let usedModel = '';
    let usedTokens = 0;
    // 生成 token（completion_tokens），用于计算真实生成速度
    let usedCompletionTokens = 0;
    // tool_call / tool_result 的序号：跨轮递增，保证 UI 能唯一匹配
    //（每轮都从 0 开始的话，下一轮的 result 会覆盖上一轮同序号的工具）
    let toolCallSeq = 0;
    let rawFullReply = '';
    let refusalRetried = false;
    // 模型空响应（没说话也没调工具）时的追问重试次数
    let emptyRetries = 0;
    const emptyRetryLimit = this.config.emptyRetryLimit ?? 0;
    let lastFinishReason: string | undefined;
    let lastContextStats: ContextStats | undefined;
    // 本轮 artifact 存储 + 只读工具重复调用缓存
    const artifacts = new ArtifactStore();
    const resultCache = new Map<string, string>();
    /** 每轮新建清洗器：标签抑制状态不跨轮复用，避免上一轮的未闭合标签吞掉下一轮正文 */
    let sanitizeContent = createContentSanitizer();

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
      let roundFinishReason: string | undefined;
      // 拒答守卫：gateOpen=false 时内容先攒在 gateBuf，够长或确认非拒答才放行
      let gateOpen = !gate?.enabled;
      let gateBuf = '';

      // ✅ 每次调模型前先做上下文治理：旧工具结果压成预览，避免每轮重发全文。
      const contextStats = this.contextManager.compact(messages);
      if (
        contextStats.compactedToolResults > 0 ||
        contextStats.compactedToolCalls > 0 ||
        contextStats.compactedMessages > 0
      ) {
        lastContextStats = contextStats;
      }

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
      const { stream, candidate, release, dispose } =
        await this.createChatStream(
          chain,
          payload,
          signal,
          this.config.showRoutingThought
            ? (t) => pendingThoughts.push(t)
            : undefined,
          sampling,
        );
      usedModel = `${candidate.provider}:${candidate.model}`;
      try {
        // 建流阶段的路径决策（限流重试、切换候选）先于内容吐出；
        // 放进 try 里是为了消费者在 thought 处提前断开时也能释放锁/中止请求。
        for (const t of pendingThoughts) yield { type: 'thought', content: t };

        for await (const chunk of withIdleTimeout(
          stream,
          this.streamIdleTimeoutMs,
          signal,
          dispose,
        )) {
          if (signal?.aborted) {
            console.log('检测到用户中断，强行跳出大模型流生成。');
            break;
          }

          if (roundTtft === null) roundTtft = Date.now() - streamStartTime;

          // stream_options.include_usage 的用量只在最后一个 chunk 下发，累加起来
          const chunkUsage = (chunk as any).usage;
          if (chunkUsage?.total_tokens) {
            usedTokens += chunkUsage.total_tokens;
            usedCompletionTokens += chunkUsage.completion_tokens ?? 0;
          }

          const chunkFinishReason = (chunk as any).choices?.[0]?.finish_reason;
          if (chunkFinishReason) roundFinishReason = chunkFinishReason;

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
            // 剥掉模型误写进正文的 XML 风格标签（<think>/<tool_call>/<web_search>）
            const clean = sanitizeContent(textContent);
            if (!clean) continue;
            roundReply += clean;
            if (gateOpen) {
              rawFullReply += clean;
              yield { type: 'content', content: clean };
            } else {
              gateBuf += clean;
              // 攒够阈值仍未见拒答 → 放行已攒内容，之后正常流式。
              // 拒答识别依赖「无法」，所以只要 32 字内没出现「无法」就可以提前放行，
              // 不必死等 120 字——否则短回答要等整条流结束才显示，体感像“不吐字”。
              const gateThreshold = gate?.threshold ?? 120;
              const earlyOpen =
                gateBuf.length >= 32 && !gateBuf.includes('无法');
              if (gateBuf.length >= gateThreshold || earlyOpen) {
                gateOpen = true;
                rawFullReply += gateBuf;
                yield { type: 'content', content: gateBuf };
              }
            }
          }
        }
      } finally {
        // 先中止底层请求（正常结束也无害），再放智谱锁：
        // 锁必须等整条流读完才放，避免并发打爆免费层的 1 并发限制
        dispose();
        release?.();
      }

      // 记录本轮 finish_reason；最后一轮的值会带进 done 事件
      lastFinishReason = roundFinishReason;

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
      if (!toolCalls.length) {
        // 空响应（没说话也没调工具）：按配置换候选/追问重试，避免模型半路停
        if (
          !roundReply &&
          emptyRetryLimit > 0 &&
          emptyRetries < emptyRetryLimit &&
          round < maxToolRounds
        ) {
          emptyRetries++;
          if (chain.length > 1) {
            // 还有备用候选：换下一个模型再试（比追问同一模型更有效）
            chain = chain.slice(1);
          } else {
            messages.push({
              role: 'user',
              content:
                '你上一轮没有输出任何内容或工具调用。请继续完成用户的任务；如需执行操作请调用工具。',
            });
          }
          round--; // 不额外消耗轮数
          continue;
        }
        break;
      }
      if (signal?.aborted) return;

      // 有工具要调：把 assistant(tool_calls) 与执行结果追加进上下文，再来一轮流式
      messages.push({
        role: 'assistant',
        content: roundReply || null,
        tool_calls: toolCalls,
      });
      const results = new Map<string, string>();
      const parseArgs = (call: AccumulatedToolCall) => {
        try {
          return JSON.parse(call.function.arguments || '{}');
        } catch {
          return {};
        }
      };
      const isReadOnly = (call: AccumulatedToolCall) =>
        tools.find(
          (t) => t.definition.function.name === call.function.name,
        )?.readOnly === true;

      // 1. 先吐所有 tool_call，UI 立刻展示本轮要调哪些工具
      const roundToolStartIndex = toolCallSeq;
      for (let index = 0; index < toolCalls.length; index++) {
        const call = toolCalls[index];
        yield {
          type: 'tool_call',
          name: call.function.name,
          args: parseArgs(call),
          index: toolCallSeq++,
        };
      }

      // 2. 写工具：审批通过后再吐 file_edit 动画，避免用户未确认就已开始改文件
      for (let index = 0; index < toolCalls.length; index++) {
        const call = toolCalls[index];
        if (isReadOnly(call)) continue;
        if (signal?.aborted) break;
        const args = parseArgs(call);
        const tool = tools.find(
          (t) => t.definition.function.name === call.function.name,
        );
        const invalid = tool
          ? validateToolArgs(tool.definition, args)
          : null;
        const edit = invalid
          ? undefined
          : parseFileEdit(call.function.name, args);

        // 审批检查：需要审批的工具，先等用户确认，通过后再吐 file_edit 动画
        const policy = approvalPolicy?.(call.function.name, args) ?? 'allow';
        let preApproved = false;
        if (policy === 'ask' && edit) {
          if (signal?.aborted) {
            // aborted, skip
          } else if (requestApproval) {
            preApproved = await requestApproval({
              toolName: call.function.name,
              args,
              signal,
            });
            if (!preApproved) {
              results.set(call.id, `用户拒绝执行：${call.function.name}`);
              continue;
            }
          } else {
            // 配置为 ask 但没有审批钩子：安全起见拒绝
            results.set(call.id, `用户拒绝执行：${call.function.name}`);
            continue;
          }
        }

        if ((policy !== 'deny') && edit) yield { type: 'file_edit', edit };
        results.set(
          call.id,
          await this.executeToolCall(call, args, {
            signal,
            approvalPolicy,
            requestApproval,
            tools,
            artifacts,
            resultCache,
            preApproved,
          }),
        );
      }

      // 3. 只读工具并行执行
      const readOnlyCalls = toolCalls.filter((call) => isReadOnly(call));
      await Promise.all(
        readOnlyCalls.map(async (call) => {
          const args = parseArgs(call);
          results.set(
            call.id,
            await this.executeToolCall(call, args, {
              signal,
              approvalPolicy,
              requestApproval,
              tools,
              artifacts,
              resultCache,
            }),
          );
        }),
      );

      // 4. 按原始顺序回填 tool_result 与消息（序号与步骤 1 的 tool_call 一一对应）
      for (let index = 0; index < toolCalls.length; index++) {
        const call = toolCalls[index];
        const result = results.get(call.id) ?? '工具未执行';
        yield {
          type: 'tool_result',
          name: call.function.name,
          result,
          index: roundToolStartIndex + index,
        };
        messages.push({
          tool_call_id: call.id,
          role: 'tool',
          name: call.function.name,
          content: result,
        });
      }

      // ✅ 验证闭环：本轮有编辑类工具且还有下一轮时，自动跑验证并回填结果。
      //    宿主提供验证器（editor 场景是 lint/typecheck），返回 null 表示跳过。
      if (
        verifyAfterTools &&
        round < maxToolRounds &&
        !signal?.aborted &&
        toolCalls.some((call) =>
          (editToolNames ?? DEFAULT_EDIT_TOOL_NAMES).includes(
            call.function.name,
          ),
        )
      ) {
        yield { type: 'thought', content: '🔎 自动验证改动…' };
        let verdict: string | null = null;
        try {
          verdict = await verifyAfterTools({
            toolNames: toolCalls.map((call) => call.function.name),
            signal,
          });
        } catch (e: any) {
          verdict = `验证执行失败：${e?.message ?? String(e)}`;
        }
        if (verdict) {
          messages.push({
            role: 'user',
            content:
              `【自动验证】\n${capVerdict(verdict)}\n` +
              '请根据验证结果继续修复；如果验证已通过，直接给出最终答复。',
          });
        }
      }
    }

    const fullReply = rawFullReply
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<\/?think>/g, '')
      .replace(/<\/?tool_call>/g, '')
      .trimStart();

    yield {
      type: 'done',
      model: usedModel,
      tokens: usedTokens,
      completionTokens: usedCompletionTokens,
      fullReply,
      finishReason: lastFinishReason,
      truncated: lastFinishReason === 'length',
      context: lastContextStats,
    };
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
