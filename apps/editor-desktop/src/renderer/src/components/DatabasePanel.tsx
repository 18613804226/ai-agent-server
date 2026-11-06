import { useCallback, useEffect, useState } from 'react';
import { isReadOnlySql } from '@repo/editor-agent';
import type { DatabaseSchema } from '@repo/editor-agent';

interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

/** 把驱动返回的行（对象数组）转成表格 */
function rowsToTable(rows: unknown[]): QueryResult {
  if (!rows.length) return { columns: [], rows: [] };
  const first = rows[0];
  const columns = Array.isArray(first)
    ? first.map((_, i) => `col${i + 1}`)
    : Object.keys(first as Record<string, unknown>);
  const data = rows.map((r) =>
    Array.isArray(r)
      ? r
      : columns.map((c) => (r as Record<string, unknown>)[c]),
  );
  return { columns, rows: data };
}

/**
 * 数据库面板：左侧表结构，右侧 SQL 执行与结果。
 * 通过 IPC 走主进程，渲染层不接触连接密码。
 */
export function DatabasePanel() {
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [sql, setSql] = useState('SELECT * FROM users');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadSchema = useCallback(async () => {
    try {
      setSchema(await window.electron.database.schema());
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void loadSchema();
  }, [loadSchema]);

  const run = useCallback(async (sqlText: string) => {
    const text = sqlText.trim();
    if (!text) return;
    setBusy(true);
    setError('');
    try {
      if (isReadOnlySql(text)) {
        const res = await window.electron.database.query(text);
        setResult(rowsToTable(res.rows));
      } else {
        const res = await window.electron.database.execute(text);
        setResult({
          columns: ['result'],
          rows: [
            [`执行成功，受影响行数：${res.rowsAffected ?? '未知'}`],
          ],
        });
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const openTable = useCallback(
    async (name: string) => {
      // 显示用 SQL；实际取数走服务端按驱动方言引用标识符，避免注入
      setSql(`SELECT * FROM ${name} LIMIT 200`);
      setBusy(true);
      setError('');
      try {
        const res = await window.electron.database.tableRows(name, 200);
        setResult(rowsToTable(res.rows));
      } catch (e: any) {
        setError(e?.message || String(e));
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return (
    <div className="db-panel">
      <div className="db-panel-side">
        <div className="db-panel-head">
          <span>表结构</span>
          <button
            type="button"
            className="ghost small"
            onClick={() => void loadSchema()}
          >
            刷新
          </button>
        </div>
        <div className="db-tables">
          {schema?.tables.map((t) => (
            <div key={t.name} className="db-table">
              <button
                type="button"
                className="db-table-name"
                onClick={() => void openTable(t.name)}
                title={`查看 ${t.name}`}
              >
                {t.name}
              </button>
              <div className="db-cols">
                {t.columns.map((c) => (
                  <span key={c.name} className="db-col" title={c.type}>
                    {c.name}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {!schema ? <div className="muted small">加载中…</div> : null}
        </div>
      </div>

      <div className="db-panel-main">
        <div className="db-sql-row">
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void run(sql);
              }
            }}
            placeholder="输入 SQL，Ctrl+Enter 运行"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => void run(sql)}
            disabled={busy}
          >
            {busy ? '运行中…' : '运行'}
          </button>
        </div>

        {error ? <div className="db-error">⚠️ {error}</div> : null}

        {result ? (
          <div className="db-result">
            {result.columns.length === 0 ? (
              <div className="muted small">（无结果）</div>
            ) : (
              <table className="db-result-table">
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((v, j) => (
                        <td key={j}>{String(v ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
