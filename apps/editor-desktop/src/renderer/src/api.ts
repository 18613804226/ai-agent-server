/**
 * 后端 API 客户端：登录 + agent 会话 + SSE 流式对话。
 * 后端已开 CORS（origin: '*'），渲染进程直接 fetch 即可。
 */
import { CLOUD_BACKEND_URL } from './cloud';

const backendUrl = CLOUD_BACKEND_URL.replace(/\/+$/, '');

export interface ServerEvent {
  type: 'thought' | 'content' | 'sources' | 'error' | 'done' | string;
  content?: string;
  sources?: unknown[];
  model?: string;
  tokens?: number;
  /** 云端模式：工具执行请求 */
  runId?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export interface WorkspaceNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  children?: WorkspaceNode[];
}

const TOKEN_KEY = 'editor_desktop_token';
const DEVICE_KEY = 'editor_desktop_device_id';

let token: string | null = localStorage.getItem(TOKEN_KEY);

export function getToken(): string | null {
  return token;
}

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export async function login(): Promise<void> {
  const res = await fetch(`${backendUrl}/auth/anonymous-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: getDeviceId(), platform: 'desktop' }),
  });
  if (!res.ok) throw new Error(`登录失败：HTTP ${res.status}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error('登录响应缺少 token');
  token = data.token;
  localStorage.setItem(TOKEN_KEY, token);
}

export async function createSession(): Promise<{ id: string }> {
  const res = await fetch(`${backendUrl}/agent/editor/session`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`创建会话失败：HTTP ${res.status}`);
  return (await res.json()) as { id: string };
}

/**
 * 发起 SSE 流式对话。
 * 后端用 POST + text/event-stream，EventSource 不支持 POST，所以用 fetch 手动解析。
 */
export async function streamChat(
  sessionId: string,
  query: string,
  onEvent: (ev: ServerEvent) => void,
  signal?: AbortSignal,
  model?: string,
): Promise<void> {
  const res = await fetch(
    `${backendUrl}/agent/editor/session/${sessionId}/stream`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, ...(model ? { model } : {}) }),
      signal,
    },
  );
  if (!res.ok || !res.body) {
    throw new Error(`请求失败：HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as ServerEvent);
        } catch {
          // 忽略无法解析的帧（心跳等）
        }
      }
    }
  }
}

/**
 * 云端模式：后端编排，工具在本地执行。
 * 收到 tool_request 时回调 execTool，再把结果 POST 回后端。
 */
export async function streamChatWithTools(
  sessionId: string,
  query: string,
  onEvent: (ev: ServerEvent) => void,
  execTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  options: {
    signal?: AbortSignal;
    model?: string;
    workspaceRoots?: string[];
    workspaceSummary?: string;
  } = {},
): Promise<void> {
  const res = await fetch(
    `${backendUrl}/agent/editor/session/${sessionId}/stream`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        localTools: true,
        ...(options.model ? { model: options.model } : {}),
        ...(options.workspaceRoots?.length
          ? { workspaceRoots: options.workspaceRoots }
          : {}),
        ...(options.workspaceSummary
          ? { workspaceSummary: options.workspaceSummary }
          : {}),
      }),
      signal: options.signal,
    },
  );
  if (!res.ok || !res.body) {
    throw new Error(`请求失败：HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let ev: ServerEvent;
        try {
          ev = JSON.parse(line.slice(5).trim()) as ServerEvent;
        } catch {
          continue;
        }
        if (ev.type === 'tool_request' && ev.runId && ev.id && ev.name) {
          const result = await execTool(ev.name, ev.args ?? {});
          await fetch(
            `${backendUrl}/agent/editor/session/${sessionId}/tool-result`,
            {
              method: 'POST',
              headers: { ...authHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: ev.runId, id: ev.id, result }),
            },
          );
          continue;
        }
        onEvent(ev);
      }
    }
  }
}

export async function fetchWorkspaceTree(): Promise<{
  root: string;
  nodes: WorkspaceNode[];
}> {
  const res = await fetch(`${backendUrl}/agent/editor/workspace/tree`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`读取工作区失败：HTTP ${res.status}`);
  return (await res.json()) as { root: string; nodes: WorkspaceNode[] };
}

export async function fetchWorkspaceFile(
  path: string,
): Promise<{ path: string; content: string }> {
  const res = await fetch(
    `${backendUrl}/agent/editor/workspace/file?path=${encodeURIComponent(path)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw new Error(`读取文件失败：HTTP ${res.status}`);
  return (await res.json()) as { path: string; content: string };
}

function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
