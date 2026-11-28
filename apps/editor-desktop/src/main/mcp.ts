import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RegisteredTool } from '@repo/agent-orchestrator';
import { getConfig } from './config.js';
import type { McpServerConfig, McpServerStatus } from '../shared/mcp.js';

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_RESULT_CHARS = 8000;
/** 极端重名时的兜底后缀，保证工具名唯一 */
let uniqueSuffix = 0;

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
  tools: McpToolInfo[];
}

/** 工具名只允许 [a-zA-Z0-9_-]，且不超过 64 字符 */
function safeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || 'server';
}

function toolName(server: McpServerConfig, name: string): string {
  return `mcp_${safeName(server.id)}_${safeName(name)}`.slice(0, 64);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function serializeResult(result: unknown): string {
  const data = result as {
    isError?: boolean;
    content?: Array<Record<string, any>>;
  };
  const parts: string[] = [];
  for (const item of data.content ?? []) {
    if (item.type === 'text') {
      parts.push(String(item.text ?? ''));
    } else if (item.type === 'image') {
      parts.push(`[图片 ${item.mimeType ?? ''}]`);
    } else if (item.type === 'resource') {
      parts.push(
        String(item.resource?.text ?? `[资源 ${item.resource?.uri ?? ''}]`),
      );
    } else if (item.type === 'resource_link') {
      parts.push(`[资源链接 ${item.uri ?? item.name ?? ''}]`);
    } else {
      parts.push(`[${item.type ?? '未知内容'}]`);
    }
  }
  let text = parts.join('\n').trim() || '（MCP 工具无输出）';
  if (data.isError) text = `MCP 工具返回错误：\n${text}`;
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n…（结果过长，已截断）`
    : text;
}

/**
 * MCP 客户端管理器：按配置连接 stdio / Streamable HTTP 服务，
 * 把每个 MCP 工具包装成 agent 工具。连接变化时通知宿主重建工具列表。
 */
class McpManager {
  private readonly servers = new Map<string, ConnectedServer>();
  private readonly errors = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private reloading: Promise<void> | null = null;
  /** 重连过程中又收到 reload 请求：结束后再跑一次，避免用到旧配置 */
  private reloadQueued = false;

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 宿主重建失败不影响其他监听者
      }
    }
  }

  /** 重新连接全部启用的 MCP Server（配置变更 / 启动时调用） */
  reload(): Promise<void> {
    if (this.reloading) {
      this.reloadQueued = true;
      return this.reloading;
    }
    this.reloading = this.doReload().finally(() => {
      this.reloading = null;
      if (this.reloadQueued) {
        this.reloadQueued = false;
        void this.reload();
      }
    });
    return this.reloading;
  }

  private async doReload(): Promise<void> {
    await this.dispose();
    this.errors.clear();
    const configs = getConfig().mcpServers ?? [];
    const enabled = configs.filter((s) => s.enabled);
    await Promise.all(enabled.map((cfg) => this.connect(cfg)));
    this.emit();
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const label = config.name || config.id;
    let client: Client | null = null;
    try {
      if (config.transport === 'http') {
        if (!config.url) throw new Error('缺少 MCP 服务地址');
        const transport = new StreamableHTTPClientTransport(
          new URL(config.url),
        );
        client = new Client(
          { name: 'dietai-editor', version: '1.0.0' },
          { capabilities: {} },
        );
        await withTimeout(
          client.connect(transport),
          CONNECT_TIMEOUT_MS,
          `连接 ${label} `,
        );
      } else {
        if (!config.command) throw new Error('缺少启动命令');
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (typeof value === 'string') env[key] = value;
        }
        Object.assign(env, config.env ?? {});
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env,
          cwd: config.cwd || undefined,
          stderr: 'pipe',
        });
        client = new Client(
          { name: 'dietai-editor', version: '1.0.0' },
          { capabilities: {} },
        );
        await withTimeout(
          client.connect(transport),
          CONNECT_TIMEOUT_MS,
          `连接 ${label} `,
        );
      }

      const listed = await withTimeout(
        client.listTools(),
        CONNECT_TIMEOUT_MS,
        `读取 ${label} 工具列表`,
      );
      this.servers.set(config.id, {
        config,
        client,
        tools: (listed.tools ?? []) as McpToolInfo[],
      });
      this.errors.delete(config.id);
    } catch (e: any) {
      this.errors.set(config.id, e?.message || String(e));
      try {
        await client?.close();
      } catch {
        // 连接失败时关闭也可能失败，忽略
      }
    }
  }

  /** 当前已连接服务暴露的工具（每次调用都重新生成，配置变化后自动生效） */
  getTools(): RegisteredTool[] {
    const out: RegisteredTool[] = [];
    const used = new Set<string>();
    for (const server of this.servers.values()) {
      for (const info of server.tools) {
        const base = toolName(server.config, info.name);
        let name = base;
        let suffix = 2;
        // 预留后缀长度再截断，避免 64 字符名加后缀后仍与原名相同导致死循环
        while (used.has(name) && suffix <= 9999) {
          const tail = `_${suffix++}`;
          name = `${base.slice(0, Math.max(1, 64 - tail.length))}${tail}`;
        }
        while (used.has(name)) {
          name = `${base.slice(0, 50)}_${(uniqueSuffix++).toString(36)}`;
        }
        used.add(name);
        const serverLabel = server.config.name || server.config.id;
        out.push({
          definition: {
            type: 'function',
            function: {
              name,
              description: `[MCP ${serverLabel}] ${
                info.description || info.name
              }`,
              parameters:
                info.inputSchema && typeof info.inputSchema === 'object'
                  ? info.inputSchema
                  : { type: 'object', properties: {} },
            },
          },
          // MCP 工具可能有副作用：不标记只读，交给审批策略
          handler: async (args, context) => {
            try {
              const result = await withTimeout(
                server.client.callTool(
                  { name: info.name, arguments: args },
                  undefined,
                  context.signal
                    ? { signal: context.signal, timeout: CALL_TIMEOUT_MS }
                    : { timeout: CALL_TIMEOUT_MS },
                ),
                CALL_TIMEOUT_MS + 1000,
                `调用 ${serverLabel}/${info.name} `,
              );
              return serializeResult(result);
            } catch (e: any) {
              return `MCP 调用失败（${serverLabel}/${info.name}）：${
                e?.message || e
              }`;
            }
          },
        });
      }
    }
    return out;
  }

  status(): McpServerStatus[] {
    return (getConfig().mcpServers ?? []).map((config) => {
      const connected = this.servers.get(config.id);
      return {
        id: config.id,
        name: config.name || config.id,
        connected: Boolean(connected),
        toolCount: connected?.tools.length ?? 0,
        error: this.errors.get(config.id),
      };
    });
  }

  async dispose(): Promise<void> {
    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      servers.map(async (server) => {
        try {
          await server.client.close();
        } catch {
          // 已断开的服务关闭失败可忽略
        }
      }),
    );
  }
}

export const mcpManager = new McpManager();
