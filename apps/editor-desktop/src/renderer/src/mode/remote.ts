import { createSession, getToken, login, streamChatWithTools } from '../api';
import type { AgentTransport, ChatEvent } from './types';

async function ensureLogin(): Promise<void> {
  if (!getToken()) await login();
}

/**
 * 云端模式：后端跑编排器，工具调用通过 tool_request 回到本地执行。
 * 文件树/文件内容始终读本地（与本地模式一致）。
 */
export class RemoteTransport implements AgentTransport {
  private sessionId: string | null = null;
  private controller?: AbortController;

  get session(): string | null {
    return this.sessionId;
  }

  private async ensureSession(): Promise<string> {
    if (!this.sessionId) {
      await ensureLogin();
      const s = await createSession();
      this.sessionId = s.id;
    }
    return this.sessionId;
  }

  async run(
    query: string,
    onEvent: (ev: ChatEvent) => void,
    signal?: AbortSignal,
    options?: { model?: string },
  ): Promise<void> {
    const sessionId = await this.ensureSession();
    const roots = await window.electron.workspace.roots();
    if (!roots.length) {
      throw new Error('请先点击「打开文件夹」选择项目');
    }
    const tree = await window.electron.workspace.tree();
    const workspaceSummary = (tree.nodes as any[])
      .map((n) => {
        const children = (n.children ?? [])
          .map(
            (c: any) => `${c.type === 'dir' ? '[dir]' : '     '} ${c.name}`,
          )
          .join('\n');
        return `【${n.name}】\n${children}`;
      })
      .join('\n\n');

    this.controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;

    await streamChatWithTools(
      sessionId,
      query,
      (ev) => onEvent(ev as ChatEvent),
      (name, args) => window.electron.agent.execTool(name, args),
      {
        signal: combined,
        model: options?.model,
        workspaceRoots: roots.map((r) => r.path),
        workspaceSummary,
      },
    );
  }

  abort(): void {
    this.controller?.abort();
  }
}
