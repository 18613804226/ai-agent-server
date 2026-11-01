import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent } from '@repo/agent-orchestrator';
import type { AppConfig, ProviderConfig } from '../main/config.js';

interface AgentFileChange {
  path: string;
  kind: string;
  before?: string;
  after?: string;
  from?: string;
}

export interface RunCheckpointInfo {
  id: string;
  query: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  context?: {
    activeFile?: string;
    activeContent?: string;
    selection?: string;
  };
  changes: AgentFileChange[];
  state: string;
  updatedAt: number;
}

export interface RunStateInfo {
  state: string;
  checkpoint: RunCheckpointInfo | null;
}

/**
 * 预加载脚本：暴露最小能力。
 * - 本地模式：workspace + agent 通过 IPC 驱动 Electron 主进程
 * - 云端模式：渲染进程直接用 HTTP/SSE 连后端（后端已开 CORS）
 */
const api = {
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
    set: (next: AppConfig): Promise<AppConfig> =>
      ipcRenderer.invoke('config:set', next),
  },
  providers: {
    status: (): Promise<{
      selectedModel: string;
      providers: Array<ProviderConfig & { hasKey: boolean }>;
    }> => ipcRenderer.invoke('providers:status'),
    fetchModels: (provider: ProviderConfig): Promise<string[]> =>
      ipcRenderer.invoke('providers:fetchModels', provider),
  },
  workspace: {
    roots: (): Promise<Array<{ name: string; path: string }>> =>
      ipcRenderer.invoke('workspace:roots'),
    open: (): Promise<Array<{ name: string; path: string }>> =>
      ipcRenderer.invoke('workspace:open'),
    remove: (
      path: string,
    ): Promise<Array<{ name: string; path: string }>> =>
      ipcRenderer.invoke('workspace:remove', path),
    root: (): Promise<string | null> => ipcRenderer.invoke('workspace:root'),
    tree: (): Promise<{ root: string; nodes: unknown[] }> =>
      ipcRenderer.invoke('workspace:tree'),
    read: (path: string): Promise<{ path: string; content: string }> =>
      ipcRenderer.invoke('workspace:read', path),
    write: (path: string, content: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:write', { path, content }),
    createFile: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:createFile', path),
    createDir: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:createDir', path),
    delete: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:delete', path),
    rename: (from: string, to: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:rename', { from, to }),
    clear: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('workspace:clear'),
  },
  terminal: {
    cwd: (): Promise<string> => ipcRenderer.invoke('terminal:cwd'),
    run: (
      command: string,
    ): Promise<{ output: string; cwd: string; clear?: boolean }> =>
      ipcRenderer.invoke('terminal:run', command),
  },
  agent: {
    run: (
      query: string,
      history?: Array<{ role: 'user' | 'assistant'; content: string }>,
      context?: {
        activeFile?: string;
        activeContent?: string;
        selection?: string;
      },
    ): Promise<void> =>
      ipcRenderer.invoke('agent:run', { query, history, context }),
    execTool: (
      name: string,
      args: Record<string, unknown>,
    ): Promise<string> =>
      ipcRenderer.invoke('agent:execTool', { name, args }),
    abort: (): Promise<void> => ipcRenderer.invoke('agent:abort'),
    respondApproval: (
      id: string,
      approved: boolean,
    ): Promise<boolean> =>
      ipcRenderer.invoke('agent:respondApproval', { id, approved }),
    undoAgent: (): Promise<{ restored: string[]; failed: string[] }> =>
      ipcRenderer.invoke('agent:undo'),
    getChanges: (): Promise<AgentFileChange[]> =>
      ipcRenderer.invoke('agent:getChanges'),
    resetChanges: (): Promise<boolean> =>
      ipcRenderer.invoke('agent:resetChanges'),
    getRunState: (): Promise<RunStateInfo> =>
      ipcRenderer.invoke('agent:getRunState'),
    pause: (): Promise<RunStateInfo> => ipcRenderer.invoke('agent:pause'),
    cancel: (): Promise<RunStateInfo> => ipcRenderer.invoke('agent:cancel'),
    resume: (): Promise<RunStateInfo> => ipcRenderer.invoke('agent:resume'),
    onEvent: (callback: (ev: AgentEvent) => void): (() => void) => {
      const listener = (_event: unknown, ev: AgentEvent) => callback(ev);
      ipcRenderer.on('agent:event', listener);
      return () => ipcRenderer.removeListener('agent:event', listener);
    },
  },
};

contextBridge.exposeInMainWorld('electron', api);
