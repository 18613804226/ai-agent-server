import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { spawn } from 'child_process';
import {
  buildWorkspaceTree,
  createWorkspaceDirectory,
  decodeProcOutput,
  deleteWorkspacePath,
  execAsync,
  readWorkspaceFile,
  renameWorkspacePath,
  writeWorkspaceFile,
} from '@repo/editor-agent';
import { LocalAgent } from './agent/local-agent.js';
import { browserManager } from './browser.js';
import {
  getConfig,
  setConfig,
  type AppConfig,
  type ProviderConfig,
} from './config.js';

let localAgent: LocalAgent | null = null;
let controller: AbortController | null = null;
/** 终端当前目录（切换工作区时重置） */
let terminalCwd: string | null = null;
/** 当前通过 terminal:spawn 启动的进程（用于停止） */
let spawnedChild: ReturnType<typeof spawn> | null = null;
let spawnedPid: number | null = null;

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
          p.requiresKey === false ||
          Boolean(p.apiKey?.trim()) ||
          Boolean(process.env[p.apiKeyEnv]),
        models: p.models,
      })),
    };
  });

  ipcMain.handle(
    'providers:fetchModels',
    async (_event, provider: ProviderConfig) => {
      const apiKey =
        provider.apiKey?.trim() || process.env[provider.apiKeyEnv] || '';
      if (!apiKey) {
        throw new Error('请填写 API Key 或配置对应环境变量');
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

  ipcMain.handle(
    'terminal:run',
    async (
      _event,
      payload: { cmd: string; cwd?: string; profile?: string },
    ) => {
      const root = getAgent().root;
      if (!root) throw new Error('请先打开文件夹');
      // 每个终端标签自带 cwd；未传时回退到全局最后目录
      const cwd = payload.cwd || terminalCwd || root;
      const cmd = String(payload.cmd ?? '').trim();
      if (!cmd) return { output: '', cwd };
      if (cmd === 'clear' || cmd === 'cls') {
        return { output: '', cwd, clear: true };
      }
      if (cmd === 'cd' || cmd.startsWith('cd ')) {
        const arg =
          cmd.slice(2).trim().replace(/^["']|["']$/g, '') || root;
        const target = resolve(cwd, arg);
        const roots = getAgent().roots;
        if (!roots.some((r) => target === r || target.startsWith(r))) {
          return { output: '拒绝：不能离开工作区', cwd };
        }
        return { output: '', cwd: target };
      }
      // 根据终端类型选择 shell 执行
      const profile = payload.profile || 'cmd';
      let execCmd = cmd;
      if (profile === 'powershell') {
        execCmd = `powershell.exe -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`;
      } else if (profile === 'gitbash') {
        execCmd = `bash.exe -c "${cmd.replace(/"/g, '\\"')}"`;
      }
      try {
        const { stdout, stderr } = await execAsync(execCmd, {
          cwd,
          timeout: 60000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          encoding: 'buffer',
        });
        return {
          output: decodeProcOutput(stdout, stderr),
          cwd,
        };
      } catch (e: any) {
        return {
          output: `${decodeProcOutput(e.stdout, e.stderr)}${e.message || ''}`,
          cwd,
        };
      }
    },
  );

  // 交互式终端：spawn 长进程，实时推送输出（dev server 等）
  ipcMain.handle(
    'terminal:spawn',
    (
      event,
      payload: { cmd: string; cwd?: string; profile?: string },
    ) => {
      const root = getAgent().root;
      if (!root) throw new Error('请先打开文件夹');
      const cwd = payload.cwd || terminalCwd || root;
      const cmd = String(payload.cmd ?? '').trim();
      if (!cmd) return { pid: 0 };
      if (cmd === 'clear' || cmd === 'cls') {
        if (!event.sender.isDestroyed())
          event.sender.send('terminal:output', { type: 'clear' });
        return { pid: 0 };
      }
      if (cmd === 'cd' || cmd.startsWith('cd ')) {
        const arg = cmd.slice(2).trim().replace(/^["']|["']$/g, '') || root;
        const target = resolve(cwd, arg);
        // 终端面板允许切换到任意本地目录（用户手动操作）；AI 工具仍受工作区限制
        if (!existsSync(target)) {
          if (!event.sender.isDestroyed())
            event.sender.send('terminal:output', {
              type: 'data',
              data: `目录不存在：${target}`,
            });
          return { pid: 0 };
        }
        terminalCwd = target;
        if (!event.sender.isDestroyed())
          event.sender.send('terminal:output', { type: 'cwd', cwd: target });
        return { pid: 0 };
      }
      const profile = payload.profile || 'cmd';
      let shell: string;
      let args: string[];
      if (profile === 'powershell') {
        shell = 'powershell.exe';
        args = ['-NoProfile', '-Command', cmd];
      } else if (profile === 'gitbash') {
        shell = 'bash.exe';
        args = ['-c', cmd];
      } else {
        shell = 'cmd.exe';
        args = ['/c', cmd];
      }
      const child = spawn(shell, args, { cwd, windowsHide: true });
      const send = (data: string) => {
        if (!event.sender.isDestroyed())
          event.sender.send('terminal:output', { type: 'data', data });
      };
      child.stdout?.on('data', (buf: Buffer) => send(decodeProcOutput(buf)));
      child.stderr?.on('data', (buf: Buffer) => send(decodeProcOutput(buf)));
      child.on('close', (code) => {
        if (spawnedChild === child) {
          spawnedChild = null;
          spawnedPid = null;
        }
        if (!event.sender.isDestroyed())
          event.sender.send('terminal:output', { type: 'exit', code });
      });
      spawnedChild = child;
      spawnedPid = child.pid ?? null;
      return { pid: child.pid };
    },
  );

  // 停止进程（Windows 用 taskkill /T 杀整个进程树，否则 node 子进程会残留）
  ipcMain.handle('terminal:kill', async () => {
    const pid = spawnedPid;
    if (!pid) return false;
    spawnedChild = null;
    spawnedPid = null;
    try {
      await execAsync(`taskkill /pid ${pid} /T /F`, { windowsHide: true });
    } catch {
      // 进程可能已退出
    }
    return true;
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
        images?: string[];
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
        payload.images,
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

  // 内置浏览器
  ipcMain.handle('browser:create', (_event, url: string) =>
    browserManager.create(url),
  );
  ipcMain.handle('browser:navigate', (_event, id: number, url: string) =>
    browserManager.navigate(id, url),
  );
  ipcMain.handle(
    'browser:setBounds',
    (
      _event,
      id: number,
      bounds: { x: number; y: number; width: number; height: number },
    ) => browserManager.setBounds(id, bounds),
  );
  ipcMain.handle('browser:close', (_event, id: number) =>
    browserManager.close(id),
  );

  // 聊天会话持久化：写入 userData/chat-sessions.json
  ipcMain.handle('chat:getSessions', () => {
    const file = join(app.getPath('userData'), 'chat-sessions.json');
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  });

  ipcMain.handle('chat:saveSessions', (_event, sessions: unknown) => {
    const file = join(app.getPath('userData'), 'chat-sessions.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(sessions), 'utf8');
  });
}
