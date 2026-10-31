/**
 * 跨仓库的流式事件契约。
 *
 * 后端（apps/server）通过 SSE 下发这些事件，编辑器 demo 与外部智能体 demo
 * 的前端各自消费。**改动这里的字段属于破坏性变更**，需同步通知外部仓库。
 */

export type ServerEventType =
  | 'thought'
  | 'content'
  | 'sources'
  | 'error'
  | 'done';

export interface ThoughtEvent {
  type: 'thought';
  content: string;
}

export interface ContentEvent {
  type: 'content';
  content: string;
}

export interface SourcesEvent {
  type: 'sources';
  sources: unknown[];
}

export interface ErrorEvent {
  type: 'error';
  content: string;
}

export interface DoneEvent {
  type: 'done';
  model?: string;
  tokens?: number;
}

/** 后端 SSE 下发的单个事件 */
export type ServerEvent =
  | ThoughtEvent
  | ContentEvent
  | SourcesEvent
  | ErrorEvent
  | DoneEvent;

/** 发起一次流式对话的请求体（各 agent 可扩展） */
export interface StreamRequest {
  query?: string;
  images?: string[];
  fileIds?: string[];
  attachmentIds?: string[];
  [key: string]: unknown;
}
