import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ModelOption {
  id: string;
  label: string;
}

export interface ModelGroup {
  provider: string;
  models: ModelOption[];
}

const MENU_WIDTH = 280;

/** 自定义模型下拉（Portal 渲染，Copilot 风格分组面板） */
export function ModelSelect({
  value,
  groups,
  disabled,
  onChange,
  title,
}: {
  value: string;
  groups: ModelGroup[];
  disabled?: boolean;
  onChange: (id: string) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    setPos({
      left: Math.min(
        triggerRect.left,
        Math.max(8, window.innerWidth - MENU_WIDTH - 8),
      ),
      // 紧贴模型选择框上方（会盖住输入区域）
      bottom: window.innerHeight - triggerRect.top + 4,
    });
    setQuery('');
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const allModels = groups.flatMap((g) => g.models);
  const current = allModels.find((o) => o.id === value);
  const label = current
    ? current.label
    : value
      ? `${value}（不可用）`
      : '选择模型';

  const q = query.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({
      ...g,
      models: g.models.filter(
        (m) =>
          !q ||
          m.label.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.models.length > 0);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="chip chip-select"
        onClick={() => (open ? setOpen(false) : openMenu())}
        disabled={disabled}
        title={title}
      >
        <span className="chip-label">{label}</span>
        <span className="chip-caret">▾</span>
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              className="model-menu"
              style={{ left: pos.left, bottom: pos.bottom, width: MENU_WIDTH }}
            >
              <div className="model-menu-head">
                <span className="model-menu-title">
                  <span className="model-menu-spark">✦</span> 模型
                </span>
                <input
                  className="model-menu-search"
                  placeholder="搜索模型"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                  spellCheck={false}
                />
              </div>
              <div className="model-menu-body">
                {filtered.length === 0 ? (
                  <div className="model-menu-empty muted small">
                    没有匹配的模型
                  </div>
                ) : null}
                {filtered.map((group) => (
                  <div key={group.provider} className="model-group">
                    <div className="model-group-title">{group.provider}</div>
                    {group.models.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`model-menu-item ${
                          m.id === value ? 'active' : ''
                        }`}
                        onClick={() => {
                          onChange(m.id);
                          setOpen(false);
                        }}
                      >
                        <span className="model-item-check">
                          {m.id === value ? '✓' : ''}
                        </span>
                        <span className="model-item-label">{m.label}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
