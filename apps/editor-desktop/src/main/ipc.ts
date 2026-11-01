import { BrowserWindow, dialog, ipcMain } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import { basename, resolve } from 'path';
import {
  buildWorkspaceTree,
  createWorkspaceDirectory,
  deleteWorkspacePath,
  readWorkspaceFile,
  renameWorkspacePath,
  writeWorkspaceFile,
} from '@repo/editor-agent';
import { LocalAgent } from './agent/local-agent.js';
import {
  getConfig,
  setConfig,
  type AppConfig,
  type ProviderConfig,
} from './config.js';

const execAsync = promisify(exec);

let localAgent: LocalAgent | null = null;
let controller: AbortController | null = null;
/** 终端当前目录（切换工作区时重置） */
let terminalCwd: string | null = null;

function getAgent(): LocalAgent {
  if (!localAgent) {
    // 首次启动不预置工作区，用户点「打开文件夹」后再创建
    localAgent = new LocalAgent(getConfig().local.workspaceRoots ?? []);
  }
  return localAgent;
}

function rootInfo(): Array<{ name: string; path: string }> {
  return getAgent().roots.map((path) => ({ name: basename(path), path }));
}

function persistRoots(): void {
  const cfg = getConfig();
  setConfig({
    ...cfg,
    local: { ...cfg.local, workspaceRoots: getAgent().roots },
  });
}

export function registerIpc(): void {
  ipcMain.handle('config:get', () => getConfig());

  ipcMain.handle('config:set', (_event, next: AppConfig) => {
    const saved = setConfig(next);
    // 配置变了，丢弃旧编排器，下次对话用新 key/baseURL 重建
    getAgent().reloadConfig();
    return saved;
  });

  ipcMain.handle('providers:status', () => {
    const cfg = getConfig();
    return {
      selectedModel: cfg.selectedModel,
      providers: cfg.providers.map((p) => ({
        id: p.id,
        name: p.name,
        apiKeyEnv: p.apiKeyEnv,
        hasKey:
          p.requiresKey === false || Boolean(process.env[p.apiKeyEnv]),
        models: p.models,
      })),
    };
  });

  ipcMain.handle(
    'providers:fetchModels',
    async (_event, provider: ProviderConfig) => {
      const apiKey = process.env[provider.apiKeyEnv] || '';
      if (!apiKey) {
        throw new Error(`未配置环境变量 ${provider.apiKeyEnv}`);
      }
      const res = await fetch(
        `${provider.baseUrl.replace(/\/+$/, '')}/models`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!res.ok) {
        throw new Error(`获取模型失败：HTTP ${res.status}`);
      }
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return (data.data || []).map((m) => m.id);
    },
  );

  ipcMain.handle('workspace:roots', () => rootInfo());
  ipcMain.handle('workspace:root', () => getAgent().root);

  ipcMain.handle('workspace:open', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'multiSelections'],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return rootInfo();
    for (const dir of result.filePaths) {
      getAgent().addWorkspace(dir);
    }
    persistRoots();
    terminalCwd = null;
    return rootInfo();
  });

  ipcMain.handle('workspace:remove', (_event, path: string) => {
    getAgent().removeWorkspace(path);
    persistRoots();
    terminalCwd = null;
    return rootInfo();
  });

  ipcMain.handle('workspace:tree', () => {
    const roots = getAgent().roots;
    if (!roots.length) return { root: '', nodes: [] };
    return { root: roots[0], nodes: buildWorkspaceTree(roots) };
  });

  ipcMain.handle('workspace:read', (_event, path: string) => {
    const roots = getAgent().roots;
    if (!roots.length) throw new Error('请先打开文件夹');
    return { path, content: readWorkspaceFile(roots, path) };
  });

  ipcMain.handle(
    'workspace:write',
    (_event, payload: { path: string; content: string }) => {
      const roots = getAgent().roots;
      if (!roots.length) throw new Error('请先打开文件夹');
      writeWorkspaceFile(roots, payload.path, payload.content);
      return { ok: true };
    },
  );

  ipcMain.handle('workspace:createFile', (_event, path: string) => {
    const roots = getAgent().roots;
    if (!roots.length) throw new Error('请先打开文件夹');
    writeWorkspaceFile(roots, path, '');
    return { ok: true };
  });

  ipcMain.handle('workspace:createDir', (_event, path: string) => {
    const roots = getAgent().roots;
    if (!roots.length) throw new Error('请先打开文件夹');
    createWorkspaceDirectory(roots, path);
    return { ok: true };
  });

  ipcMain.handle('workspace:delete', (_event, path: string) => {
    const roots = getAgent().roots;
    if (!roots.length) throw new Error('请先打开文件夹');
    deleteWorkspacePath(roots, path);
    return { ok: true };
  });

  ipcMain.handle(
    'workspace:rename',
    (_event, payload: { from: string; to: string }) => {
      const roots = getAgent().roots;
      if (!roots.length) throw new Error('请先打开文件夹');
      renameWorkspacePath(roots, payload.from, payload.to);
      return { ok: true };
    },
  );

  ipcMain.handle('workspace:clear', () => {
    getAgent().clearWorkspace();
    persistRoots();
    terminalCwd = null;
    return { ok: true };
  });

  ipcMain.handle('terminal:cwd', () => terminalCwd || getAgent().root || '');

  ipcMain.handle('terminal:run', async (_event, command: string) => {
    const root = getAgent().root;
    if (!root) throw new Error('请先打开文件夹');
    if (!terminalCwd) terminalCwd = root;
    const cmd = String(command ?? '').trim();
    if (!cmd) return { output: '', cwd: terminalCwd };
    if (cmd === 'clear' || cmd === 'cls') {
      return { output: '', cwd: terminalCwd, clear: true };
    }
    if (cmd === 'cd' || cmd.startsWith('cd ')) {
      const arg =
        cmd.slice(2).trim().replace(/^["']|["']$/g, '') || root;
      const target = resolve(terminalCwd, arg);
      const roots = getAgent().roots;
      if (!roots.some((r) => target === r || target.startsWith(r))) {
        return { output: '拒绝：不能离开工作区', cwd: terminalCwd };
      }
      terminalCwd = target;
      return { output: '', cwd: terminalCwd };
    }
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: terminalCwd,
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      return { output: `${stdout || ''}${stderr || ''}`, cwd: terminalCwd };
    } catch (e: any) {
      return {
        output: `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`,
        cwd: terminalCwd,
      };
    }
  });

  ipcMain.handle(
    'agent:run',
    async (
      event,
      payload: {
        query: string;
        history?: Array<{ role: 'user' | 'assistant'; content: string }>;
        context?: {
          activeFile?: string;
          activeContent?: string;
          selection?: string;
        };
      },
    ) => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const agent = getAgent();
    // 审批请求也走同一个 agent:event 通道
    agent.setEventSink((ev) => {
      if (!event.sender.isDestroyed()) event.sender.send('agent:event', ev);
    });
    try {
      for await (const ev of agent.run(
        payload.query,
        signal,
        payload.history,
        payload.context,
      )) {
        if (event.sender.isDestroyed()) break;
        event.sender.send('agent:event', ev);
      }
    } catch (err: any) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:event', {
          type: 'error',
          content: err?.message || String(err),
        });
      }
    } finally {
      agent.setEventSink(null);
      if (controller?.signal === signal) controller = null;
    }
    },
  );

  ipcMain.handle(
    'agent:execTool',
    async (event, payload: { name: string; args: Record<string, unknown> }) => {
      const agent = getAgent();
      agent.setEventSink((ev) => {
        if (!event.sender.isDestroyed()) event.sender.send('agent:event', ev);
      });
      try {
        return await agent.execTool(payload.name, payload.args ?? {});
      } finally {
        agent.setEventSink(null);
      }
    },
  );

  ipcMain.handle('agent:abort', () => {
    controller?.abort();
  });

  ipcMain.handle(
    'agent:respondApproval',
    (_event, payload: { id: string; approved: boolean }) => {
      getAgent().respondApproval(payload.id, payload.approved);
      return true;
    },
  );

  ipcMain.handle('agent:undo', () => getAgent().undoLastRun());

  ipcMain.handle('agent:getChanges', () => getAgent().getChanges());

  ipcMain.handle('agent:resetChanges', () => {
    getAgent().resetChanges();
    return true;
  });

  ipcMain.handle('agent:getRunState', () => getAgent().getState());

  ipcMain.handle('agent:pause', () => getAgent().pause());

  ipcMain.handle('agent:cancel', () => getAgent().cancel());

  ipcMain.handle('agent:resume', async (event) => {
    const agent = getAgent();
    agent.setEventSink((ev) => {
      if (!event.sender.isDestroyed()) event.sender.send('agent:event', ev);
    });
    try {
      for await (const ev of agent.resume()) {
        if (event.sender.isDestroyed()) break;
        event.sender.send('agent:event', ev);
      }
    } finally {
      agent.setEventSink(null);
    }
    return agent.getState();
  });
}
