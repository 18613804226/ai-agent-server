import {
  cancelAgentSession,
  createSession,
  getAgentRunState,
  getToken,
  login,
  pauseAgentSession,
  streamChatWithTools,
} from '../api';
import type {
  AgentPromptContext,
  AgentTransport,
  ChatEvent,
  RunStateInfo,
} from './types';

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
  private lastContext?: AgentPromptContext;
  private lastRoots: string[] = [];
  private lastSummary = '';

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
    options?: {
      model?: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      context?: {
        activeFile?: string;
        activeContent?: string;
        selection?: string;
      };
      images?: string[];
    },
  ): Promise<void> {
    const sessionId = await this.ensureSession();
    const roots = await window.electron.workspace.roots();
    if (!roots.length) {
      throw new Error('请先点击「打开文件夹」选择项目');
    }
    const tree = await window.electron.workspace.tree();
    const flatten = (nodes: any[]): any[] =>
      nodes.flatMap((n) =>
        n.type === 'dir' ? flatten(n.children ?? []) : [n],
      );
    const files = flatten(tree.nodes as any[])
      .slice(0, 200)
      .map((n) => `  ${n.path}`)
      .join('\n');
    const workspaceSummary = `${(tree.nodes as any[])
      .map((n) => {
        const children = (n.children ?? [])
          .map(
            (c: any) => `${c.type === 'dir' ? '[dir]' : '     '} ${c.name}`,
          )
          .join('\n');
        return `【${n.name}】\n${children}`;
      })
      .join('\n\n')}\n文件（最多 200 个）：\n${files}`;

    // 新一轮开始前清空客户端改动收集
    await window.electron.agent.resetChanges();

    this.lastContext = options?.context;
    this.lastRoots = roots.map((r) => r.path);
    this.lastSummary = workspaceSummary;

    this.controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;

    await streamChatWithTools(
      sessionId,
      query,
      (ev) => {
        // 云端模式：done 时把客户端收集的改动挂上去，渲染层才能展示/撤销
        if (ev.type === 'done') {
          void window.electron.agent
            .getChanges()
            .then((changes) => onEvent({ ...ev, changes } as ChatEvent));
          return;
        }
        onEvent(ev as ChatEvent);
      },
      (name, args) => window.electron.agent.execTool(name, args),
      {
        signal: combined,
        model: options?.model,
        workspaceRoots: roots.map((r) => r.path),
        workspaceSummary,
        context: options?.context,
        images: options?.images,
      },
    );
  }

  abort(): void {
    this.controller?.abort();
  }

  async pause(): Promise<RunStateInfo> {
    const sessionId = await this.ensureSession();
    return await pauseAgentSession(sessionId);
  }

  async cancel(): Promise<RunStateInfo> {
    const sessionId = await this.ensureSession();
    return await cancelAgentSession(sessionId);
  }

  async getRunState(): Promise<RunStateInfo> {
    if (!this.sessionId) return { state: 'idle', checkpoint: null };
    return await getAgentRunState(this.sessionId);
  }

  async resume(
    onEvent: (ev: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const sessionId = await this.ensureSession();
    this.controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;

    await streamChatWithTools(
      sessionId,
      '继续执行之前的任务。',
      (ev) => {
        if (ev.type === 'done') {
          void window.electron.agent
            .getChanges()
            .then((changes) => onEvent({ ...ev, changes } as ChatEvent));
          return;
        }
        onEvent(ev as ChatEvent);
      },
      (name, args) => window.electron.agent.execTool(name, args),
      {
        signal: combined,
        model: undefined,
        workspaceRoots: this.lastRoots,
        workspaceSummary: this.lastSummary,
        context: this.lastContext,
        resume: true,
      },
    );
  }
}
