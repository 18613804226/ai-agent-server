import type {
  AgentTransport,
  ChatEvent,
  ChatHistoryItem,
  AgentPromptContext,
  RunStateInfo,
  WorkspaceNode,
  WorkspaceProvider,
  WorkspaceRootInfo,
} from './types';

/** 本地模式：通过 IPC 驱动 Electron 主进程里的编排器 + 本地工具 */
export class LocalTransport implements AgentTransport {
  private unsubscribe?: () => void;

  async run(
    query: string,
    onEvent: (ev: ChatEvent) => void,
    signal?: AbortSignal,
    options?: {
      model?: string;
      history?: ChatHistoryItem[];
      context?: AgentPromptContext;
      images?: string[];
    },
  ): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = window.electron.agent.onEvent((ev) =>
      onEvent(ev as ChatEvent),
    );
    const onAbort = () => void window.electron.agent.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      await window.electron.agent.run(
        query,
        options?.history,
        options?.context,
        options?.images,
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
  }

  async resume(
    onEvent: (ev: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = window.electron.agent.onEvent((ev) =>
      onEvent(ev as ChatEvent),
    );
    const onAbort = () => void window.electron.agent.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      await window.electron.agent.resume();
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
  }

  async pause(): Promise<RunStateInfo> {
    return await window.electron.agent.pause();
  }

  async cancel(): Promise<RunStateInfo> {
    return await window.electron.agent.cancel();
  }

  async getRunState(): Promise<RunStateInfo> {
    return await window.electron.agent.getRunState();
  }

  abort(): void {
    void window.electron.agent.abort();
  }
}

/** 本地工作区：主进程直接读本地磁盘 */
export class LocalWorkspace implements WorkspaceProvider {
  async root(): Promise<string> {
    return (await window.electron.workspace.root()) || '';
  }

  async roots(): Promise<WorkspaceRootInfo[]> {
    return window.electron.workspace.roots();
  }

  async tree(): Promise<WorkspaceNode[]> {
    const r = await window.electron.workspace.tree();
    return r.nodes as WorkspaceNode[];
  }

  async readFile(path: string): Promise<string> {
    const r = await window.electron.workspace.read(path);
    return r.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await window.electron.workspace.write(path, content);
  }

  async clear(): Promise<void> {
    await window.electron.workspace.clear();
  }

  async open(): Promise<void> {
    await window.electron.workspace.open();
  }

  async removeRoot(path: string): Promise<void> {
    await window.electron.workspace.remove(path);
  }
}
