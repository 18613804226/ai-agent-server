import { useMemo, useState } from 'react';
import type { FileChange } from '../mode/types';
import { diffLines, groupHunks, mergeHunks } from '../diff';

/**
 * 改动对比 + diff 块审批：
 * 按 hunk 展示差异，用户可逐块勾选接受/拒绝，点「应用改动」后写回文件。
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
          <input
            type="checkbox"
            checked={allAccepted}
            onChange={toggleAll}
          />
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
      {hunks.length === 0 ? (
        <div className="diff-empty">没有差异</div>
      ) : (
        hunks.map((hunk) => (
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
        ))
      )}
    </div>
  );
}
