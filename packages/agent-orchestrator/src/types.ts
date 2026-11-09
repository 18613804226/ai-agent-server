/**
 * 编排器核心类型。
 *
 * 这些类型是宿主（NestJS / Electron）与编排器之间的契约：
 * 编排器只负责产出 AgentEvent，宿主决定怎么消费（SSE / IPC / 日志）。
 */
import type { ArtifactStore } from './artifact-store.js';

/** 编排器向外吐出的原子事件类型 */
export type AgentEventType =
  | 'thought'
  | 'content'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'done'
  | 'file_edit'
  | 'browser_open';

/** 一次工具调用的流式分片（由 tool-call-accumulator 归并） */
export interface ToolCallLike {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 工具定义：OpenAI function calling 的 schema */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 工具执行上下文：让 handler 能感知取消、artifact 与自身名字 */
export interface ToolContext {
  /** 客户端中断信号；长耗时工具应主动监听 */
  signal?: AbortSignal;
  /** 当前工具名，便于日志/审计 */
  toolName: string;
  /** 本轮 artifact 存储：大结果可存句柄，模型用 read_artifact 取全文 */
  artifacts?: ArtifactStore;
}

/** 工具执行器：入参是模型给的原始 args，返回字符串结果回填给模型 */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<string> | string;

/** 已注册工具：定义 + 实现 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** 只读工具可并行执行；默认 false（写操作串行 + 审批） */
  readOnly?: boolean;
}

/** 编辑器运行期上下文：当前文件、选区等，注入 system prompt */
export interface AgentPromptContext {
  activeFile?: string;
  activeContent?: string;
  selection?: string;
}

/**
 * 生成系统提示时可用的运行期输入。
 * 目前只有本轮问题与编辑器上下文，便于 agent 按提问注入计算结果（如节日公历日期）。
 */
export interface AgentPromptInput {
  /** 本轮用户问题 */
  query?: string;
  /** 编辑器上下文（active file / 选区） */
  context?: AgentPromptContext;
}

/** 自动验证上下文：工具轮结束后触发 */
export interface VerifyContext {
  /** 本轮实际执行的工具名 */
  toolNames: string[];
  /** 可选：本次验证要运行的 scripts（如 ['test']） */
  scripts?: string[];
  signal?: AbortSignal;
}

/**
 * 自动验证钩子：返回要回填给模型的验证结果文本；
 * 返回 null 表示当前工作区没有可执行的验证脚本，跳过。
 */
export type VerifyHook = (context: VerifyContext) => Promise<string | null>;

/** 审批上下文：执行可能危险的工具前触发 */
export interface ApprovalContext {
  toolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

/** 审批钩子：true 允许执行，false 拒绝（拒绝结果会作为 tool_result 回填） */
export type ApprovalHook = (context: ApprovalContext) => Promise<boolean>;

/** 工具审批策略：allow 直接执行 / ask 询问 / deny 直接拒绝 */
export type ApprovalPolicy = (
  toolName: string,
  args: Record<string, unknown>,
) => 'allow' | 'ask' | 'deny';

/**
 * 一个 agent 的定义：只描述「工具集 + 系统提示」，不描述循环。
 * 循环由 AgentOrchestrator + 宿主统一驱动。
 */
export interface AgentDefinition {
  /** 路由里用的 agent id，如 editor / general */
  id: string;
  /** 该 agent 注册的工具集 */
  tools: RegisteredTool[];
  /** 生成系统提示（每次运行都重新求值，便于反映工作区等动态状态） */
  buildSystemPrompt: (input?: AgentPromptInput) => string;
  /** 是否把工具定义发给模型，默认 true */
  includeTools?: boolean;
  /** 写操作后自动验证；返回 null 表示跳过 */
  verifyAfterTools?: VerifyHook;
  /** 触发自动验证的编辑类工具名 */
  editToolNames?: string[];
  /**
   * 该 agent 的工具循环轮数上限（含最终回答轮）。
   * 不传则用编排器默认值。编辑器任务链路长，通常要 15 轮左右；
   * 问答类场景轮数应更小，由调用方显式传 maxToolRounds 覆盖。
   */
  maxToolRounds?: number;
  /** 工具审批策略；未配置默认 allow */
  approvalPolicy?: ApprovalPolicy;
  /** 审批钩子；policy 为 ask 但未配置时按拒绝处理 */
  requestApproval?: ApprovalHook;
}

/** 一次文件改动（编辑器工具产出，宿主可据此展示 diff） */
export interface FileChange {
  /** 相对工作区路径 */
  path: string;
  kind: 'created' | 'modified' | 'deleted' | 'renamed';
  /** 改动前内容（新建时为空） */
  before?: string;
  /** 改动后内容（删除时为空） */
  after?: string;
  /** renamed 时的原路径 */
  from?: string;
  /** true=待用户确认（diff 块审批），确认后才写入 */
  pending?: boolean;
}

/**
 * 流式文件编辑：工具调用解析出的单次编辑意图。
 * 编排器在工具入参解析完成后吐出，供宿主做「一行一行往下刷」的动画。
 */
export interface FileEdit {
  /** 文件相对路径 */
  path: string;
  /** 操作类型 */
  kind: 'create' | 'modify' | 'delete' | 'rename';
  /** 改动前内容（modify/create 时有值） */
  before?: string;
  /** 改动后内容（modify/create 时有值） */
  after?: string;
  /** rename 时的原路径 */
  from?: string;
  /** rename 时的目标路径 */
  to?: string;
  /** 局部替换用的原文（edit_file 场景） */
  old_string?: string;
  /** 局部替换用的新文（edit_file 场景） */
  new_string?: string;
}

/** 一次上下文压缩的统计信息 */
export interface ContextStats {
  /** 压缩前的估算输入 token */
  beforeTokens: number;
  /** 压缩后的估算输入 token */
  afterTokens: number;
  /** 被压缩的 tool 结果条数 */
  compactedToolResults: number;
  /** 被压缩的 tool_call 参数个数 */
  compactedToolCalls: number;
  /** 被压缩的普通消息条数 */
  compactedMessages: number;
}

/** 编排器事件：宿主无关，按需取字段 */
export interface AgentEvent {
  type: AgentEventType;
  /** thought / content / error 的文本 */
  content?: string;
  /** tool_call / tool_result 的工具名 */
  name?: string;
  /** tool_call 的入参（已解析） */
  args?: unknown;
  /** tool_result 的返回文本 */
  result?: string;
  /** tool_call / tool_result 的本轮序号，UI 据此匹配 */
  index?: number;
  /** done 事件携带的实际模型 */
  model?: string;
  /** done 事件携带的累计 token（total_tokens，含输入） */
  tokens?: number;
  /** done 事件携带的生成 token（completion_tokens），用于计算真实生成速度 */
  completionTokens?: number;
  /** done 事件携带的输入 token（prompt_tokens），宿主无需再靠 total - completion 倒推 */
  inputTokens?: number;
  /** done 事件携带的输出 token（与 completionTokens 同口径，含思考） */
  outputTokens?: number;
  /** 输出 token 中「思考」占的部分（completion_tokens_details.reasoning_tokens） */
  reasoningTokens?: number;
  /** 命中上游 prompt cache 的输入 token（有才给） */
  cachedTokens?: number;
  /** 首个 token（含思考）的延迟，相对本次 run 开始，单位 ms */
  firstTokenMs?: number;
  /** 正文首个 token 的延迟，相对本次 run 开始，单位 ms（t/s 的分母起点） */
  firstAnswerTokenMs?: number;
  /** 思考段落总耗时，ms（首末思考 chunk 的间隔，有才给） */
  thoughtDurationMs?: number;
  /** 正文生成耗时，ms（首末正文 chunk 的间隔，有才给） */
  answerDurationMs?: number;
  /** done 事件携带的最终回答（已清理 <think>/<tool_call> 标签） */
  fullReply?: string;
  /** 最后一轮的 finish_reason（stop / length / tool_calls / content_filter 等） */
  finishReason?: string;
  /** finish_reason=length 时为 true，宿主应提示回答被截断 */
  truncated?: boolean;
  /** 本轮上下文压缩统计（发生压缩时才有） */
  context?: ContextStats;
  /** done 事件携带的本轮文件改动（编辑器工具产出） */
  changes?: FileChange[];
  /** browser_open 事件携带的目标 URL */
  url?: string;
  /** file_edit 事件携带的编辑意图（流式动画用） */
  edit?: FileEdit;
}

/**
 * 内容闸门：在内容真正发给前端前先扣留一小段，用于识别「模型拒答」等场景。
 * 命中后由 nextCandidates 给出新的候选链重试本轮；返回 null 表示不再重试。
 */
export interface ContentGate {
  enabled: boolean;
  /** 攒够多少字符就放行（默认 120） */
  threshold?: number;
  /** 判断已攒内容是否为需要重试的拒答 */
  isRefusal: (text: string) => boolean;
  /** 命中拒答时给出新的候选链；返回 null/空数组表示放弃重试 */
  nextCandidates: (
    current: import('./model-cascade.js').ModelCandidate[],
  ) => import('./model-cascade.js').ModelCandidate[] | null;
}

/** 编排器输入：一次对话运行所需的全部材料 */
export interface AgentInput {
  /** 已组装好的消息序列（含 system / history / 本轮 user），编排器会就地追加 */
  messages: Array<Record<string, unknown>>;
  /** 可用工具；空数组表示纯对话 */
  tools?: RegisteredTool[];
  /** 最多工具轮数，默认 4 */
  maxToolRounds?: number;
  /** 是否把工具定义发给模型（实时查询等场景置 false） */
  includeTools?: boolean;
  /** 写操作后自动验证（覆盖 agent 定义） */
  verifyAfterTools?: VerifyHook;
  /** 触发自动验证的编辑类工具名（覆盖 agent 定义） */
  editToolNames?: string[];
  /** 工具审批策略（覆盖 agent 定义） */
  approvalPolicy?: ApprovalPolicy;
  /** 审批钩子（覆盖 agent 定义） */
  requestApproval?: ApprovalHook;
  /** 候选链覆盖；不传则用 complexity 推导 */
  candidates?: import('./model-cascade.js').ModelCandidate[];
  /** 复杂度；candidates 缺省时用于推导候选链 */
  complexity?: import('./model-cascade.js').Complexity;
  /**
   * 采样参数覆盖，仅下发给智谱候选（qwen 与代码 Agent 链路不受影响）。
   * 不传则用模型服务端默认值。
   */
  sampling?: {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
  };
  /** 客户端中断信号 */
  signal?: AbortSignal;
}
