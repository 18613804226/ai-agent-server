import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent } from '@repo/agent-orchestrator';
import type { AppConfig, ProviderConfig } from '../main/config.js';
import type {
  DatabaseConfig,
  DatabaseConnectionInput,
} from '../shared/database.js';
import type { DatabaseSchema } from '@repo/editor-agent';

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
      cwd?: string,
      profile?: string,
    ): Promise<{ output: string; cwd: string; clear?: boolean }> =>
      ipcRenderer.invoke('terminal:run', { cmd: command, cwd, profile }),
    spawn: (
      command: string,
      cwd?: string,
      profile?: string,
    ): Promise<{ pid: number }> =>
      ipcRenderer.invoke('terminal:spawn', { cmd: command, cwd, profile }),
    kill: (): Promise<boolean> => ipcRenderer.invoke('terminal:kill'),
    onOutput: (
      callback: (ev: {
        type: 'data' | 'clear' | 'cwd' | 'exit';
        data?: string;
        cwd?: string;
        code?: number;
      }) => void,
    ): (() => void) => {
      const listener = (_event: unknown, ev: unknown) =>
        callback(ev as never);
      ipcRenderer.on('terminal:output', listener);
      return () => ipcRenderer.removeListener('terminal:output', listener);
    },
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
      images?: string[],
    ): Promise<void> =>
      ipcRenderer.invoke('agent:run', { query, history, context, images }),
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
  chat: {
    getSessions: (): Promise<unknown> =>
      ipcRenderer.invoke('chat:getSessions'),
    saveSessions: (sessions: unknown): Promise<void> =>
      ipcRenderer.invoke('chat:saveSessions', sessions),
  },
  database: {
    list: (): Promise<DatabaseConfig> =>
      ipcRenderer.invoke('database:list'),
    save: (conn: DatabaseConnectionInput): Promise<DatabaseConfig> =>
      ipcRenderer.invoke('database:save', conn),
    delete: (id: string): Promise<DatabaseConfig> =>
      ipcRenderer.invoke('database:delete', id),
    setActive: (id: string): Promise<DatabaseConfig> =>
      ipcRenderer.invoke('database:setActive', id),
    test: (
      conn: DatabaseConnectionInput,
    ): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('database:test', conn),
    schema: (): Promise<DatabaseSchema> =>
      ipcRenderer.invoke('database:schema'),
    query: (sql: string): Promise<{ rows: unknown[] }> =>
      ipcRenderer.invoke('database:query', sql),
    execute: (sql: string): Promise<{ rowsAffected: number | null }> =>
      ipcRenderer.invoke('database:execute', sql),
    tableRows: (
      name: string,
      limit?: number,
    ): Promise<{ rows: unknown[] }> =>
      ipcRenderer.invoke('database:tableRows', name, limit),
    resetDemo: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('database:resetDemo'),
  },
  browser: {
    create: (url: string): Promise<number> =>
      ipcRenderer.invoke('browser:create', url),
    navigate: (
      id: number,
      url: string,
    ): Promise<{ ok: boolean; url: string }> =>
      ipcRenderer.invoke('browser:navigate', id, url),
    setBounds: (
      id: number,
      bounds: { x: number; y: number; width: number; height: number },
    ): Promise<void> => ipcRenderer.invoke('browser:setBounds', id, bounds),
    close: (id: number): Promise<void> =>
      ipcRenderer.invoke('browser:close', id),
  },
  // 同步 IPC：阻塞到主进程把窗口按钮底色刷出去再返回，
  // 保证标题栏与网页配色在同一帧切换，不落后一个 IPC 往返
  setTheme: (theme: 'light' | 'dark'): void => {
    ipcRenderer.sendSync('theme:set', theme);
  },
};

contextBridge.exposeInMainWorld('electron', api);
