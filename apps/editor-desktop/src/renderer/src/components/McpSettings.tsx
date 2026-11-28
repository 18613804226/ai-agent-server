import { useCallback, useEffect, useState } from 'react';
import type {
  McpServerConfig,
  McpServerStatus,
} from '../mode/types';

function argsToText(args?: string[]): string {
  return (args ?? []).join('\n');
}

function textToArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function envToText(env?: Record<string, string>): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

/** 设置里的 MCP Server 管理：启用、传输方式、命令/参数/环境变量 */
export function McpSettings({
  servers,
  onChange,
}: {
  servers: McpServerConfig[];
  onChange: (next: McpServerConfig[]) => void;
}) {
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [loading, setLoading] = useState(false);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatuses(await window.electron.mcp.status());
    } catch {
      setStatuses([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const update = (id: string, patch: Partial<McpServerConfig>) => {
    onChange(
      servers.map((server) =>
        server.id === id ? { ...server, ...patch } : server,
      ),
    );
  };

  const add = () => {
    const id = crypto.randomUUID().slice(0, 8);
    onChange([
      ...servers,
      {
        id,
        name: 'New MCP Server',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: {},
        cwd: '',
        url: '',
      },
    ]);
  };

  const remove = (id: string) => {
    onChange(servers.filter((server) => server.id !== id));
  };

  const empty = servers.length === 0;

  return (
    <section className="settings-section">
      <div className="section-head">
        <h4>MCP Server</h4>
        <button className="ghost small" onClick={add}>
          添加 MCP
        </button>
      </div>
      <p className="hint">
        MCP 工具会以 <code>mcp_&lt;服务&gt;_&lt;工具&gt;</code> 的名字注入本地模式
        agent（云端模式只使用后端内置工具）。保存设置后自动重连。
      </p>
      {empty ? null : (
        <ul className="mcp-list">
          {servers.map((server) => (
            <McpServerRow
              key={server.id}
              server={server}
              status={statuses.find((s) => s.id === server.id)}
              onUpdate={(patch) => update(server.id, patch)}
              onRemove={() => remove(server.id)}
            />
          ))}
        </ul>
      )}
      <div className="mcp-status-bar">
        <span className="muted small mcp-status-text">
          {empty
            ? '还没有 MCP Server'
            : `${statuses.filter((s) => s.connected).length} / ${statuses.length} 已连接`}
        </span>
        {empty ? null : (
          <button
            className="ghost small"
            onClick={() => void refreshStatus()}
            disabled={loading}
          >
            {loading ? '检查中…' : '刷新连接状态'}
          </button>
        )}
      </div>
    </section>
  );
}

function McpServerRow({
  server,
  status,
  onUpdate,
  onRemove,
}: {
  server: McpServerConfig;
  status?: McpServerStatus;
  onUpdate: (patch: Partial<McpServerConfig>) => void;
  onRemove: () => void;
}) {
  const [argsText, setArgsText] = useState(() => argsToText(server.args));
  const [envText, setEnvText] = useState(() => envToText(server.env));

  return (
    <li className="mcp-server">
      <div className="mcp-server-head">
        <label className="mcp-enabled">
          <input
            type="checkbox"
            checked={server.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
          />
          启用
        </label>
        <input
          className="mcp-name-input"
          value={server.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="服务名称"
        />
        <select
          value={server.transport}
          onChange={(e) =>
            onUpdate({ transport: e.target.value === 'http' ? 'http' : 'stdio' })
          }
        >
          <option value="stdio">stdio</option>
          <option value="http">HTTP</option>
        </select>
        <button className="ghost small" onClick={onRemove}>
          删除
        </button>
      </div>

      {server.transport === 'http' ? (
        <label className="mcp-field">
          <span>服务地址</span>
          <input
            value={server.url ?? ''}
            onChange={(e) => onUpdate({ url: e.target.value })}
            placeholder="http://127.0.0.1:3001/mcp"
          />
        </label>
      ) : (
        <>
          <label className="mcp-field">
            <span>启动命令</span>
            <input
              value={server.command ?? ''}
              onChange={(e) => onUpdate({ command: e.target.value })}
              placeholder="npx"
            />
          </label>
          <label className="mcp-field">
            <span>参数（每行一个）</span>
            <textarea
              rows={2}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              onBlur={() => onUpdate({ args: textToArgs(argsText) })}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
            />
          </label>
          <label className="mcp-field">
            <span>工作目录（可选）</span>
            <input
              value={server.cwd ?? ''}
              onChange={(e) => onUpdate({ cwd: e.target.value })}
              placeholder="留空使用应用当前目录"
            />
          </label>
          <label className="mcp-field">
            <span>环境变量（KEY=VALUE，每行一个）</span>
            <textarea
              rows={2}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              onBlur={() => onUpdate({ env: textToEnv(envText) })}
              placeholder={'API_KEY=xxx'}
            />
          </label>
        </>
      )}

      <div className="mcp-server-status">
        {status?.connected ? (
          <span className="mcp-ok">已连接 · {status.toolCount} 个工具</span>
        ) : status?.error ? (
          <span className="mcp-error" title={status.error}>
            连接失败：{status.error}
          </span>
        ) : (
          <span className="muted small">未连接（保存后自动连接）</span>
        )}
      </div>
    </li>
  );
}
