import { useEffect, useState } from 'react';
import type {
  DatabaseConfig,
  DatabaseConnectionInput,
} from '../mode/types';
import { DEMO_DB_ID } from '../mode/types';

const DRIVERS: Array<{
  id: 'sqlite' | 'postgres' | 'mysql';
  label: string;
}> = [
  { id: 'sqlite', label: 'SQLite' },
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'mysql', label: 'MySQL' },
];

const EMPTY: DatabaseConnectionInput = {
  id: '',
  name: '',
  driver: 'sqlite',
  filename: '',
};

function connectionLabel(conn: {
  driver: string;
  name?: string;
  host?: string;
  port?: number;
  database?: string;
  filename?: string;
}): string {
  if (conn.driver === 'sqlite') return conn.filename || ':memory:';
  return `${conn.host ?? 'localhost'}:${conn.port ?? ''}/${conn.database ?? ''}`;
}

/** 连接编辑表单 */
function ConnectionForm({
  value,
  busy,
  onSave,
  onTest,
  onCancel,
}: {
  value: DatabaseConnectionInput;
  busy: boolean;
  onSave: (conn: DatabaseConnectionInput) => void;
  onTest: (conn: DatabaseConnectionInput) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DatabaseConnectionInput>(value);
  const set = <K extends keyof DatabaseConnectionInput>(
    key: K,
    v: DatabaseConnectionInput[K],
  ) => setDraft((d) => ({ ...d, [key]: v }));

  const isSqlite = draft.driver === 'sqlite';

  return (
    <div className="db-form">
      <label className="db-field">
        <span>名称</span>
        <input
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="我的数据库"
        />
      </label>
      <label className="db-field">
        <span>类型</span>
        <select
          value={draft.driver}
          onChange={(e) =>
            set(
              'driver',
              e.target.value as DatabaseConnectionInput['driver'],
            )
          }
        >
          {DRIVERS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>

      {isSqlite ? (
        <label className="db-field">
          <span>文件路径</span>
          <input
            value={draft.filename ?? ''}
            onChange={(e) => set('filename', e.target.value)}
            placeholder="C:\\path\\to\\demo.db"
          />
        </label>
      ) : (
        <>
          <label className="db-field">
            <span>主机</span>
            <input
              value={draft.host ?? ''}
              onChange={(e) => set('host', e.target.value)}
              placeholder="localhost"
            />
          </label>
          <label className="db-field">
            <span>端口</span>
            <input
              type="number"
              value={draft.port ?? ''}
              onChange={(e) =>
                set('port', e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder={draft.driver === 'postgres' ? '5432' : '3306'}
            />
          </label>
          <label className="db-field">
            <span>数据库名</span>
            <input
              value={draft.database ?? ''}
              onChange={(e) => set('database', e.target.value)}
            />
          </label>
          <label className="db-field">
            <span>用户名</span>
            <input
              value={draft.user ?? ''}
              onChange={(e) => set('user', e.target.value)}
            />
          </label>
          <label className="db-field">
            <span>密码（留空则不修改）</span>
            <input
              type="password"
              value={draft.password ?? ''}
              onChange={(e) => set('password', e.target.value)}
            />
          </label>
          <label className="db-field db-check">
            <input
              type="checkbox"
              checked={Boolean(draft.ssl)}
              onChange={(e) => set('ssl', e.target.checked)}
            />
            <span>使用 SSL</span>
          </label>
        </>
      )}

      <div className="db-form-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(draft)}
        >
          保存
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => onTest(draft)}
        >
          测试连接
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    </div>
  );
}

/** 设置里的数据库连接管理 */
export function DatabaseSettings() {
  const [config, setConfig] = useState<DatabaseConfig>({
    connections: [],
    activeId: '',
  });
  const [editing, setEditing] = useState<DatabaseConnectionInput | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setConfig(await window.electron.database.list());
    } catch (e: any) {
      setMessage(e?.message || String(e));
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (conn: DatabaseConnectionInput) => {
    setBusy(true);
    setMessage('');
    try {
      const toSave = conn.id ? conn : { ...conn, id: crypto.randomUUID() };
      setConfig(await window.electron.database.save(toSave));
      setEditing(null);
      setMessage('已保存');
    } catch (e: any) {
      setMessage(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async (conn: DatabaseConnectionInput) => {
    setBusy(true);
    setMessage('');
    try {
      const res = await window.electron.database.test(conn);
      setMessage(res.message);
    } catch (e: any) {
      setMessage(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      setConfig(await window.electron.database.delete(id));
    } catch (e: any) {
      setMessage(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const activate = async (id: string) => {
    setBusy(true);
    try {
      setConfig(await window.electron.database.setActive(id));
    } catch (e: any) {
      setMessage(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const resetDemo = async () => {
    setBusy(true);
    setMessage('');
    try {
      await window.electron.database.resetDemo();
      setMessage('已重置演示数据');
    } catch (e: any) {
      setMessage(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <div className="section-head">
        <h4>数据库</h4>
        <button
          className="ghost small"
          onClick={() => setEditing({ ...EMPTY })}
        >
          添加连接
        </button>
      </div>

      {config.connections.length === 0 ? (
        <div className="muted small">还没有数据库连接</div>
      ) : (
        <ul className="provider-list">
          {config.connections.map((c) => (
            <li key={c.id}>
              <div className="provider-info">
                <div className="provider-name">
                  <input
                    type="radio"
                    name="db-active"
                    checked={c.id === config.activeId}
                    onChange={() => void activate(c.id)}
                    title="设为活动连接"
                  />
                  <span>{c.name}</span>{' '}
                  <span className="muted small">{c.driver}</span>
                </div>
                <div className="muted small">{connectionLabel(c)}</div>
              </div>
              <div className="provider-actions">
                <button
                  className="ghost small"
                  onClick={() =>
                    setEditing({
                      ...c,
                      password: '',
                    })
                  }
                >
                  编辑
                </button>
                <button
                  className="ghost small"
                  onClick={() => void test({ ...c, password: '' })}
                >
                  测试
                </button>
                <button
                  className="ghost small"
                  onClick={() => void remove(c.id)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="hint">
        数据库连接用于 AI 工具（<code>query_database</code> /{' '}
        <code>execute_sql</code>
        ）和「数据库」面板。密码经系统钥匙串加密后保存在本地。写操作会走「数据库操作审批」。
      </p>

      {message ? <div className="hint">{message}</div> : null}

      {config.connections.find((c) => c.id === config.activeId)?.id ===
      DEMO_DB_ID ? (
        <div className="db-form-actions">
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => void resetDemo()}
          >
            重置演示数据
          </button>
        </div>
      ) : null}

      {editing ? (
        <ConnectionForm
          key={editing.id}
          value={editing}
          busy={busy}
          onSave={save}
          onTest={test}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}
