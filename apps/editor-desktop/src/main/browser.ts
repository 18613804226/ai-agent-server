import {
  BrowserWindow,
  WebContentsView,
  type Rectangle,
} from 'electron';

interface BrowserTab {
  id: number;
  view: WebContentsView;
  url: string;
}

/** 只允许访问本机服务（localhost / 127.0.0.1） */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * 内置浏览器：管理 WebContentsView 标签。
 * 仅允许 http(s) 且 host 在白名单内，防止内嵌浏览器被用于访问本地文件/任意站点。
 */
export class BrowserManager {
  private tabs = new Map<number, BrowserTab>();
  private nextId = 1;

  private mainWindow(): BrowserWindow {
    const win =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('没有可用的窗口');
    return win;
  }

  isAllowed(url: string): boolean {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return ALLOWED_HOSTS.has(u.hostname);
    } catch {
      return false;
    }
  }

  create(url: string): number {
    const win = this.mainWindow();
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.contentView.addChildView(view);
    const id = this.nextId++;
    this.tabs.set(id, { id, view, url: 'about:blank' });
    this.navigate(id, url);
    return id;
  }

  navigate(id: number, url: string): { ok: boolean; url: string } {
    const tab = this.tabs.get(id);
    if (!tab) return { ok: false, url: '' };
    if (!this.isAllowed(url)) {
      return { ok: false, url: tab.url };
    }
    tab.url = url;
    void tab.view.webContents.loadURL(url);
    return { ok: true, url };
  }

  setBounds(id: number, bounds: Rectangle): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.view.setBounds({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    });
  }

  close(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const win = BrowserWindow.getAllWindows()[0];
    win?.contentView.removeChildView(tab.view);
    try {
      tab.view.webContents.close();
    } catch {
      // 已销毁
    }
    this.tabs.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }
}

export const browserManager = new BrowserManager();
