import type { FileChange } from './types.js';

/**
 * Run 状态机：宿主层（编辑器 / 服务端）共用。
 *
 *   idle → running → paused → running → done
 *                       ↘ cancelled
 *   running → done / failed / cancelled
 *
 * 编排器只负责 ReAct 循环，不持有运行态；状态机放在宿主层，
 * 本地模式和云端模式各自持久化（桌面 userData / 服务端会话）。
 */
export type RunState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface RunCheckpoint {
  id: string;
  query: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  context?: {
    activeFile?: string;
    activeContent?: string;
    selection?: string;
  };
  changes: FileChange[];
  state: RunState;
  updatedAt: number;
}

export type RunEvent =
  | 'start'
  | 'pause'
  | 'resume'
  | 'finish'
  | 'fail'
  | 'cancel'
  | 'abort';

/** 纯函数状态转移；非法转移保持原状态 */
export function nextRunState(
  current: RunState,
  event: RunEvent,
): RunState {
  switch (event) {
    case 'start':
      return current === 'idle' || current === 'paused' || current === 'cancelled'
        ? 'running'
        : current;
    case 'pause':
      return current === 'running' ? 'paused' : current;
    case 'resume':
      return current === 'paused' ? 'running' : current;
    case 'finish':
      return current === 'running' ? 'done' : current;
    case 'fail':
      return current === 'running' ? 'failed' : current;
    case 'cancel':
      return current === 'running' ? 'cancelled' : current;
    case 'abort':
      return current === 'running' ? 'cancelled' : current;
    default:
      return current;
  }
}
