import type { FileChange } from '@repo/agent-orchestrator';

export type { FileChange };

/** 工具产生一次文件改动时回调（宿主用它收集 diff） */
export type ChangeListener = (change: FileChange) => void;
