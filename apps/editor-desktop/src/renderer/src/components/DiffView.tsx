import { useMemo, useState } from 'react';
import type { FileChange } from '../mode/types';
import { diffLines, groupHunks, mergeHunks, type DiffLine } from '../diff';

interface DiffRow {
  before?: DiffLine;
  after?: DiffLine;
}

/** 把行级 diff 配对成并排行（左旧右新） */
function pairDiff(before: string, after: string): DiffRow[] {
  const lines = diffLines(before, after);
  const rows: DiffRow[] = [];
  let pendingDel: DiffRow['before'][] = [];
  for (const line of lines) {
    if (line.type === 'same') {
      for (const d of pendingDel) rows.push({ before: d });
      pendingDel = [];
      rows.push({ before: line, after: line });
    } else if (line.type === 'del') {
      pendingDel.push(line);
    } else {
      const del = pendingDel.shift();
      rows.push({ before: del, after: line });
    }
  }
  for (const d of pendingDel) rows.push({ before: d });
  return rows;
}

/**
 * 改动对比：左旧右新并排 + hunk 逐块选择（接受/拒绝后应用）。
 */
export function DiffView({
  change,
  onApply,
}: {
  change: FileChange;
  onApply: (content: string) => void;
}) {
  const before = change.before ?? '';
  const after = change.after ?? '';
  const rows = useMemo(() => pairDiff(before, after), [before, after]);
  const hunks = useMemo(
    () => groupHunks(diffLines(before, after)),
    [before, after],
  );
  const [accepted, setAccepted] = useState<Set<number>>(
    () => new Set(hunks.map((h) => h.id)),
  );

  const allAccepted = accepted.size === hunks.length;

  if (change.kind === 'renamed') {
    return (
      <div className="diff-empty">
        已重命名：{change.from} → {change.path}
      </div>
    );
  }
  if (change.kind === 'deleted') {
    return <div className="diff-empty">已删除：{change.path}</div>;
  }

  const toggleAll = () => {
    setAccepted(allAccepted ? new Set() : new Set(hunks.map((h) => h.id)));
  };

  const toggle = (id: number) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="diff-blocks">
      <div className="diff-blocks-header">
        <span className="diff-blocks-title" title={change.path}>
          {change.path}
        </span>
        <label className="diff-blocks-all">
          <input type="checkbox" checked={allAccepted} onChange={toggleAll} />
          全选
        </label>
        <button
          type="button"
          className="diff-apply-btn"
          onClick={() => onApply(mergeHunks(before, after, accepted))}
        >
          应用改动
        </button>
      </div>

      {/* 并排对比：左旧右新 */}
      <div className="diff-split">
        <div className="diff-pane">
          <div className="diff-pane-title">旧版本</div>
          <div className="diff-pane-body">
            {rows.map((r, i) => (
              <div
                key={i}
                className={`diff-row ${r.before ? r.before.type : 'empty'}`}
              >
                <span className="diff-no">{r.before?.oldNo ?? ''}</span>
                <span className="diff-text">{r.before?.text ?? ''}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="diff-pane">
          <div className="diff-pane-title">新版本</div>
          <div className="diff-pane-body">
            {rows.map((r, i) => (
              <div
                key={i}
                className={`diff-row ${r.after ? r.after.type : 'empty'}`}
              >
                <span className="diff-no">{r.after?.newNo ?? ''}</span>
                <span className="diff-text">{r.after?.text ?? ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* hunk 逐块选择 */}
      {hunks.length === 0 ? (
        <div className="diff-empty">没有差异</div>
      ) : (
        <div className="diff-hunks">
          <div className="diff-hunks-title">按块选择</div>
          {hunks.map((hunk) => (
            <div
              key={hunk.id}
              className={`diff-hunk${
                accepted.has(hunk.id) ? ' accepted' : ' rejected'
              }`}
            >
              <label className="diff-hunk-head">
                <input
                  type="checkbox"
                  checked={accepted.has(hunk.id)}
                  onChange={() => toggle(hunk.id)}
                />
                <span className="diff-hunk-range">
                  @@ -{hunk.beforeStart},{hunk.beforeLines.length} +
                  {hunk.afterStart},{hunk.afterLines.length} @@
                </span>
              </label>
              <pre className="diff-hunk-body">
                {hunk.beforeLines.map((l, i) => (
                  <div key={`d${i}`} className="diff-line del">
                    -{l}
                  </div>
                ))}
                {hunk.afterLines.map((l, i) => (
                  <div key={`a${i}`} className="diff-line add">
                    +{l}
                  </div>
                ))}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
