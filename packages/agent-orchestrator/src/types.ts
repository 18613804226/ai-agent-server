/**
 * 编排器核心类型。
 *
 * 这些类型是宿主（NestJS / Electron）与编排器之间的契约：
 * 编排器只负责产出 AgentEvent，宿主决定怎么消费（SSE / IPC / 日志）。
 */

/** 编排器向外吐出的原子事件类型 */
export type AgentEventType =
  | 'thought'
  | 'content'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'done'
  | 'file_edit';

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

/** 工具执行器：入参是模型给的原始 args，返回字符串结果回填给模型 */
export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<string> | string;

/** 已注册工具：定义 + 实现 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

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
  buildSystemPrompt: () => string;
  /** 是否把工具定义发给模型，默认 true */
  includeTools?: boolean;
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
  /** done 事件携带的实际模型 */
  model?: string;
  /** done 事件携带的累计 token */
  tokens?: number;
  /** done 事件携带的最终回答（已清理 <think>/<tool_call> 标签） */
  fullReply?: string;
  /** done 事件携带的本轮文件改动（编辑器工具产出） */
  changes?: FileChange[];
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
  /** 候选链覆盖；不传则用 complexity 推导 */
  candidates?: import('./model-cascade.js').ModelCandidate[];
  /** 复杂度；candidates 缺省时用于推导候选链 */
  complexity?: import('./model-cascade.js').Complexity;
  /** 客户端中断信号 */
  signal?: AbortSignal;
}
