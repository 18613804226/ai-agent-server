import { app, BrowserWindow, shell } from 'electron';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { registerIpc } from './ipc.js';
import { loadEnv } from './env.js';

// 必须在 registerIpc / getConfig 之前加载，provider 的 key 从 env 读取
loadEnv();

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

/**
 * 窗口/任务栏图标：把 icon.png（Windows 建议 icon.ico）放到 resources/ 即可。
 * 打包后的应用图标由 electron-builder 的 build.icon 决定。
 */
function resolveIcon(): string | undefined {
  const dirs = [
    join(__dirname, '../../resources'),
    join(process.cwd(), 'resources'),
  ];
  // 优先约定名，其次 resources 下任意 .ico / .png
  for (const dir of dirs) {
    for (const name of ['icon.ico', 'icon.png']) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  for (const dir of dirs) {
    try {
      const file = readdirSync(dir).find((n) => /\.(ico|png)$/i.test(n));
      if (file) return join(dir, file);
    } catch {
      /* 目录不存在 */
    }
  }
  return undefined;
}

function createWindow(): void {
  const icon = resolveIcon();
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: false,
    title: 'DieTai Editor Desktop',
    ...(icon ? { icon } : {}),
    webPreferences: {
      // electron-vite 在 "type": "module" 下产出 ESM 预加载脚本（.mjs）
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM 预加载脚本需要关闭 sandbox
      sandbox: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  // 外链用系统浏览器打开，不在应用内跳转
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
