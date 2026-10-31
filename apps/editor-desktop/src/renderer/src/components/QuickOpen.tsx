import { useMemo, useState } from 'react';
import { flattenFiles } from '../files';
import type { WorkspaceNode } from '../mode/types';

export function QuickOpen({
  nodes,
  onSelect,
  onClose,
}: {
  nodes: WorkspaceNode[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const files = useMemo(() => flattenFiles(nodes), [nodes]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    return list.slice(0, 50);
  }, [files, query]);

  const choose = (path: string) => {
    onSelect(path);
    onClose();
  };

  return (
    <div className="quickopen-backdrop" onClick={onClose}>
      <div className="quickopen" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder="输入文件名搜索…"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter' && results[active]) {
              e.preventDefault();
              choose(results[active]);
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
        <ul className="quickopen-list">
          {results.map((file, i) => (
            <li key={file}>
              <button
                className={i === active ? 'active' : ''}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(file)}
              >
                {file}
              </button>
            </li>
          ))}
          {!results.length ? (
            <li className="muted small">没有匹配的文件</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
