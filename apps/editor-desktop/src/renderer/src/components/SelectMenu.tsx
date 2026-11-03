import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SelectMenuOption {
  value: string;
  label: string;
}

/**
 * 通用下拉选择（Portal 渲染，替代原生 select）。
 * 原生 select 在 Windows 上是系统弹窗，样式受限、滚动卡顿。
 */
export function SelectMenu({
  value,
  options,
  onChange,
  placeholder = '请选择',
  disabled,
}: {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPos({ left: rect.left, top: rect.bottom + 4, width: rect.width });
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

  const current = options.find((o) => o.value === value);
  const label = current ? current.label : value || placeholder;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        onClick={() => (open ? setOpen(false) : openMenu())}
        disabled={disabled}
      >
        <span className="select-trigger-label">{label}</span>
        <span className="select-trigger-caret">
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m4 6 4 4 4-4" />
          </svg>
        </span>
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              className="model-menu"
              style={{ left: pos.left, top: pos.top, width: pos.width }}
            >
              <div className="model-menu-body">
                {options.length === 0 ? (
                  <div className="model-menu-empty muted small">没有可选项</div>
                ) : null}
                {options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`model-menu-item${
                      o.value === value ? ' active' : ''
                    }`}
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <span className="model-item-check">
                      {o.value === value ? '✓' : ''}
                    </span>
                    <span className="model-item-label">{o.label}</span>
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
