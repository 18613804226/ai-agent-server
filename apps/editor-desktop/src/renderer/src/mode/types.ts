export type AgentMode = 'local' | 'remote';

export interface WorkspaceNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  children?: WorkspaceNode[];
}

export interface WorkspaceRootInfo {
  name: string;
  path: string;
}

export interface ModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  vision?: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKeyEnv: string;
  /** 直接配置的 API Key；优先于 apiKeyEnv 对应的环境变量 */
  apiKey?: string;
  requiresKey?: boolean;
  models: ModelConfig[];
}

export interface ProviderStatus {
  id: string;
  name: string;
  apiKeyEnv: string;
  hasKey: boolean;
  models: ModelConfig[];
}

export interface AppConfig {
  providers: ProviderConfig[];
  selectedModel: string;
  /** 工具审批：always 询问 / auto 自动放行 */
  approvalMode?: 'ask' | 'auto';
  local: { workspaceRoot?: string };
  remote: { model?: string };
}

export interface FileChange {
  path: string;
  kind: 'created' | 'modified' | 'deleted' | 'renamed';
  before?: string;
  after?: string;
  from?: string;
}

/** 两种模式共用的流式事件（本地 IPC / 云端 SSE 结构一致） */
/** 审批预览：根据工具入参算出的 before/after */
export interface ApprovalPreview {
  kind: 'create' | 'modify' | 'delete' | 'rename' | 'command';
  path?: string;
  from?: string;
  before?: string;
  after?: string;
  command?: string;
}

export interface ChatEvent {
  type:
    | 'thought'
    | 'content'
    | 'tool_call'
    | 'tool_result'
    | 'sources'
    | 'error'
    | 'done'
    | 'file_edit'
    | string;
  content?: string;
  name?: string;
  /** tool_call 事件携带的已解析入参（读/写哪个文件、执行什么命令） */
  args?: Record<string, unknown>;
  result?: string;
  sources?: unknown[];
  model?: string;
  /** done 事件携带的累计 token（total_tokens，含输入） */
  tokens?: number;
  /** done 事件携带的生成 token（completion_tokens） */
  completionTokens?: number;
  /** done 事件携带的本轮文件改动 */
  changes?: FileChange[];
  /** file_edit 事件携带的编辑意图（流式动画用） */
  edit?: FileEdit;
  /** browser_open 事件携带的目标 URL */
  url?: string;
  /** approval_request 事件 */
  id?: string;
  toolName?: string;
  preview?: ApprovalPreview[];
  /** tool_call / tool_result 的本轮序号，UI 据此匹配 */
  index?: number;
}

/** 流式文件编辑意图：工具调用解析出的单次编辑，供编辑器做「一行一行往下刷」动画 */
export interface FileEdit {
  path: string;
  kind: 'create' | 'modify' | 'delete' | 'rename';
  before?: string;
  after?: string;
  from?: string;
  to?: string;
  old_string?: string;
  new_string?: string;
}

export interface WorkspaceProvider {
  /** 主工作区根目录 */
  root(): Promise<string>;
  /** 所有工作区文件夹 */
  roots(): Promise<WorkspaceRootInfo[]>;
  /** 目录树（每个文件夹是顶层节点） */
  tree(): Promise<WorkspaceNode[]>;
  /** 读文件 */
  readFile(path: string): Promise<string>;
  /** 写文件（手动保存） */
  writeFile?(path: string, content: string): Promise<void>;
  /** 清空当前工作区 */
  clear?(): Promise<void>;
  /** 添加文件夹（多选） */
  open?(): Promise<void>;
  /** 移除某个文件夹 */
  removeRoot?(path: string): Promise<void>;
}

export interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentPromptContext {
  activeFile?: string;
  activeContent?: string;
  selection?: string;
}

export interface RunStateInfo {
  state: string;
  checkpoint: {
    id: string;
    query: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    context?: {
      activeFile?: string;
      activeContent?: string;
      selection?: string;
    };
    changes: Array<{
      path: string;
      kind: 'created' | 'modified' | 'deleted' | 'renamed';
      before?: string;
      after?: string;
      from?: string;
    }>;
    state: string;
    updatedAt: number;
  } | null;
}

export interface AgentTransport {
  run(
    query: string,
    onEvent: (ev: ChatEvent) => void,
    signal?: AbortSignal,
    options?: {
      model?: string;
      history?: ChatHistoryItem[];
      context?: AgentPromptContext;
      /** 本轮附带的图片（base64 data URL） */
      images?: string[];
    },
  ): Promise<void>;
  /** 断点续跑：从检查点继续（本地/云端都支持） */
  resume?(onEvent: (ev: ChatEvent) => void, signal?: AbortSignal): Promise<void>;
  /** 暂停当前运行 */
  pause(): Promise<RunStateInfo>;
  /** 取消当前运行 */
  cancel(): Promise<RunStateInfo>;
  /** 查询运行态与检查点 */
  getRunState(): Promise<RunStateInfo>;
  abort(): void;
}
