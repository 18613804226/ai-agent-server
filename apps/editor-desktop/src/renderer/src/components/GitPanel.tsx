import { useCallback, useEffect, useState } from 'react';
import type { GitChangeEntry, GitStatusResult } from '../../../shared/git';

const STATUS_LABEL: Record<GitChangeEntry['kind'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
};

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'git-patch-meta';
  if (line.startsWith('diff ') || line.startsWith('index ')) {
    return 'git-patch-meta';
  }
  if (line.startsWith('@@')) return 'git-patch-hunk';
  if (line.startsWith('+')) return 'git-patch-add';
  if (line.startsWith('-')) return 'git-patch-del';
  return 'git-patch-same';
}

/**
 * 侧栏 Git 变更面板：展示暂存/未暂存/未跟踪，点击文件展开该文件的 diff。
 * 纯只读，不做暂存/提交。
 */
export function GitPanel({
  enabled,
  refreshKey,
  onOpenFile,
}: {
  enabled: boolean;
  refreshKey: unknown;
  onOpenFile: (path: string) => void;
}) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [patch, setPatch] = useState<string>('');
  const [patchLoading, setPatchLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const next = await window.electron.git.status();
      setStatus(next);
      // 文件被提交/回滚后，关闭已失效的 diff
      setExpanded((current) =>
        current &&
        next.entries.some(
          (e) =>
            `${e.staged ? 'staged' : 'worktree'}:${e.gitPath}` === current,
        )
          ? current
          : null,
      );
    } catch (e: any) {
      setStatus({
        available: false,
        entries: [],
        message: e?.message || String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled, refresh]);

  const toggle = async (entry: GitChangeEntry, staged: boolean) => {
    const key = `${staged ? 'staged' : 'worktree'}:${entry.gitPath}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    setPatch('');
    setPatchLoading(true);
    try {
      const result = await window.electron.git.diff({
        gitPath: entry.gitPath,
        staged,
        untracked: entry.untracked,
      });
      setPatch(result.patch || result.message || '（没有可显示的 diff）');
    } catch (e: any) {
      setPatch(`读取 diff 失败：${e?.message || e}`);
    } finally {
      setPatchLoading(false);
    }
  };

  if (!enabled) return null;

  const entries = status?.entries ?? [];
  const staged = entries.filter((e) => e.staged);
  const unstaged = entries.filter((e) => !e.staged && (e.worktree !== ' ' || e.untracked));
  const groups: Array<{ title: string; list: GitChangeEntry[]; staged: boolean }> =
    [
      { title: '暂存的更改', list: staged, staged: true },
      { title: '更改', list: unstaged, staged: false },
    ];

  return (
    <div className="git-panel">
      <div className="git-panel-head">
        <button
          type="button"
          className="git-panel-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? '收起源代码管理' : '展开源代码管理'}
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className={open ? 'rotated' : ''}
          >
            <path d="m6 4 4 4-4 4" />
          </svg>
          源代码管理
        </button>
        <span className="git-branch" title={status?.repoRoot}>
          {status?.available
            ? status.branch || 'detached'
            : status?.message || '未检测到仓库'}
        </span>
        <button
          type="button"
          className="icon-btn git-refresh"
          title="刷新 Git 状态"
          aria-label="刷新 Git 状态"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <svg
            viewBox="0 0 16 16"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M13.5 3.5a6 6 0 1 0 1.7 4.3" />
            <path d="M14.5 2.5v3h-3" />
          </svg>
        </button>
      </div>

      {open ? (
        <div className="git-panel-body">
          {status?.available && entries.length === 0 ? (
            <div className="git-empty muted small">工作区干净</div>
          ) : null}
          {groups.map((group) =>
            group.list.length ? (
              <div key={group.title} className="git-group">
                <div className="git-group-title">
                  {group.title}
                  <span className="git-group-count">{group.list.length}</span>
                </div>
                <ul className="git-list">
                  {group.list.map((entry) => {
                    const key = `${
                      group.staged ? 'staged' : 'worktree'
                    }:${entry.gitPath}`;
                    return (
                      <li key={key} className="git-item">
                        <button
                          type="button"
                          className={`git-row ${
                            expanded === key ? 'active' : ''
                          }`}
                          onClick={() => void toggle(entry, group.staged)}
                          title={`${entry.gitPath}${
                            entry.origPath ? ` ← ${entry.origPath}` : ''
                          }`}
                        >
                          <span
                            className={`git-status-badge git-status-${entry.kind}`}
                          >
                            {STATUS_LABEL[entry.kind]}
                          </span>
                          <span className="git-path">{entry.gitPath}</span>
                        </button>
                        {expanded === key ? (
                          <div className="git-patch-wrap">
                            <div className="git-patch-actions">
                              <button
                                type="button"
                                className="ghost small"
                                onClick={() => onOpenFile(entry.path)}
                                disabled={entry.kind === 'deleted'}
                              >
                                打开文件
                              </button>
                            </div>
                            <div className="git-patch">
                              {patchLoading
                                ? '读取中…'
                                : patch
                                    .split('\n')
                                    .map((line, index) => (
                                      <div
                                        key={index}
                                        className={lineClass(line)}
                                      >
                                        {line || ' '}
                                      </div>
                                    ))}
                            </div>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}
