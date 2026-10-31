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
  tokens?: number;
  /** done 事件携带的本轮文件改动 */
  changes?: FileChange[];
  /** file_edit 事件携带的编辑意图（流式动画用） */
  edit?: FileEdit;
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

export interface AgentTransport {
  run(
    query: string,
    onEvent: (ev: ChatEvent) => void,
    signal?: AbortSignal,
    options?: { model?: string; history?: ChatHistoryItem[] },
  ): Promise<void>;
  abort(): void;
}
