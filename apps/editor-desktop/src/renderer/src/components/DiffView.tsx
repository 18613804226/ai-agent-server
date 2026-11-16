import { useEffect, useMemo, useState } from 'react';
import type { FileChange } from '../mode/types';
import { diffLines, groupHunks, mergeHunks } from '../diff';

/**
 * 改动对比：单栏统一 diff（旧行 / 新行），按块勾选后应用。
 * 不勾选的块保持修改前内容，因此「全部取消 + 应用」等价于回滚。
 */
export function DiffView({
  change,
  onApply,
  onRevert,
}: {
  change: FileChange;
  onApply: (content: string) => void;
  onRevert?: (change: FileChange) => void;
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

  // 切换到另一个文件/另一轮改动时重置勾选；否则会沿用上一个文件的块状态，
  // 新文件的块可能被误判为「已拒绝」，应用后写回旧内容。
  useEffect(() => {
    setAccepted(new Set(hunks.map((h) => h.id)));
  }, [hunks]);

  const allAccepted = hunks.length > 0 && accepted.size === hunks.length;
  const added = hunks.reduce((n, h) => n + h.afterLines.length, 0);
  const deleted = hunks.reduce((n, h) => n + h.beforeLines.length, 0);

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
        <span className="diff-stats">
          <span className="changes-added">+{added}</span>
          <span className="changes-deleted">-{deleted}</span>
        </span>
        <label className="diff-blocks-all">
          <input type="checkbox" checked={allAccepted} onChange={toggleAll} />
          全选
        </label>
        {onRevert ? (
          <button
            type="button"
            className="diff-revert-btn"
            onClick={() => onRevert(change)}
            title="放弃该文件的改动，恢复为修改前（新建文件会被删除）"
          >
            回滚此文件
          </button>
        ) : null}
        <button
          type="button"
          className="diff-apply-btn"
          disabled={!hunks.length}
          onClick={() => onApply(mergeHunks(before, after, accepted))}
          title="只把勾选的块写入文件；未勾选的块保持修改前内容"
        >
          应用所选块
        </button>
      </div>

      {hunks.length === 0 ? (
        <div className="diff-empty">没有差异</div>
      ) : (
        <div className="diff-hunks">
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
