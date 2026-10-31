import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { WorkspaceNode } from '../mode/types';

interface Props {
  nodes: WorkspaceNode[];
  activePath: string;
  onOpen: (path: string) => void;
  /** 顶层文件夹的移除回调（多根工作区） */
  onRemoveRoot?: (name: string) => void;
  /** 右键「问 AI」 */
  onAskAI?: (path: string) => void;
  /** 文件结构变化后刷新目录树 */
  onRefresh?: () => void;
  /** 删除后通知宿主清理当前打开文件 */
  onDeleted?: (path: string) => void;
  onError?: (message: string) => void;
}

type DialogState =
  | { kind: 'newFile' | 'newFolder'; dirPath: string }
  | { kind: 'rename'; node: WorkspaceNode }
  | { kind: 'delete'; node: WorkspaceNode }
  | null;

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    className={`chevron ${open ? 'open' : ''}`}
    viewBox="0 0 16 16"
    width="12"
    height="12"
    aria-hidden
  >
    <path
      d="M6 4l4 4-4 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const FolderIcon = () => (
  <svg className="file-icon folder" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path
      d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z"
      fill="currentColor"
    />
  </svg>
);

const FileIcon = () => (
  <svg className="file-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M4 1.5h5L12.5 5v9.5H4z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

function sortNodes(nodes: WorkspaceNode[]): WorkspaceNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

const parentOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

const joinPath = (dir: string, name: string) =>
  dir ? `${dir}/${name}` : name;

function PromptDialog({
  title,
  initial,
  placeholder,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="modal-body">
          <input
            autoFocus
            className="dialog-input"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onSubmit(value);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button onClick={() => onSubmit(value)}>确定</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({
  title,
  message,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="modal-body">
          <p className="confirm-message">{message}</p>
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="danger-btn" onClick={onConfirm}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

interface LevelProps extends Props {
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  onContextMenu: (
    event: ReactMouseEvent,
    node: WorkspaceNode,
    isRoot: boolean,
  ) => void;
}

function TreeLevel({
  nodes,
  depth,
  expanded,
  toggle,
  activePath,
  onOpen,
  onRemoveRoot,
  onContextMenu,
}: LevelProps) {
  return (
    <ul className="tree" role={depth === 0 ? 'tree' : 'group'}>
      {sortNodes(nodes).map((node) => {
        const isDir = node.type === 'dir';
        const open = expanded.has(node.path);
        return (
          <li
            key={node.path}
            role="treeitem"
            aria-expanded={isDir ? open : undefined}
            className={depth === 0 ? 'tree-root-item' : undefined}
          >
            <div className="tree-row-wrap">
              <button
                className={`tree-row ${isDir ? 'dir' : 'file'} ${
                  activePath === node.path ? 'active' : ''
                }`}
                style={{
                  paddingLeft: 8 + depth * 14,
                  paddingRight: depth === 0 && onRemoveRoot ? 28 : undefined,
                }}
                onClick={() => (isDir ? toggle(node.path) : onOpen(node.path))}
                onContextMenu={(e) => onContextMenu(e, node, depth === 0)}
                title={node.path}
              >
                {isDir ? (
                  <Chevron open={open} />
                ) : (
                  <span className="chevron-spacer" />
                )}
                {isDir ? <FolderIcon /> : <FileIcon />}
                <span className="tree-name">{node.name}</span>
              </button>
              {depth === 0 && onRemoveRoot ? (
                <button
                  type="button"
                  className="root-remove"
                  title="移除文件夹"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveRoot(node.name);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
            {isDir && open && node.children?.length ? (
              <TreeLevel
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                activePath={activePath}
                onOpen={onOpen}
                onRemoveRoot={onRemoveRoot}
                onContextMenu={onContextMenu}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function FileTree({
  nodes,
  activePath,
  onOpen,
  onRemoveRoot,
  onAskAI,
  onRefresh,
  onDeleted,
  onError,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    node: WorkspaceNode;
    isRoot: boolean;
  } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const createEntry = async (
    kind: 'newFile' | 'newFolder',
    dirPath: string,
    name: string,
  ) => {
    const clean = name.trim();
    setDialog(null);
    if (!clean) return;
    const path = joinPath(dirPath, clean);
    try {
      if (kind === 'newFile') {
        await window.electron.workspace.createFile(path);
        onOpen(path);
      } else {
        await window.electron.workspace.createDir(path);
      }
      onRefresh?.();
    } catch (e: any) {
      onError?.(e?.message || String(e));
    }
  };

  const renameEntry = async (node: WorkspaceNode, name: string) => {
    const clean = name.trim();
    setDialog(null);
    if (!clean || clean === node.name) return;
    try {
      await window.electron.workspace.rename(
        node.path,
        joinPath(parentOf(node.path), clean),
      );
      onRefresh?.();
    } catch (e: any) {
      onError?.(e?.message || String(e));
    }
  };

  const deleteEntry = async (node: WorkspaceNode) => {
    setDialog(null);
    try {
      await window.electron.workspace.delete(node.path);
      onDeleted?.(node.path);
      onRefresh?.();
    } catch (e: any) {
      onError?.(e?.message || String(e));
    }
  };

  if (!nodes.length) {
    return <div className="tree-empty">工作区为空</div>;
  }

  return (
    <>
      <TreeLevel
        nodes={nodes}
        depth={0}
        expanded={expanded}
        toggle={toggle}
        activePath={activePath}
        onOpen={onOpen}
        onRemoveRoot={onRemoveRoot}
        onContextMenu={(e, node, isRoot) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, node, isRoot });
        }}
      />

      {menu ? (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.node.type === 'file' ? (
            <>
              <button
                onClick={() => {
                  onOpen(menu.node.path);
                  setMenu(null);
                }}
              >
                打开
              </button>
              <button
                onClick={() => {
                  onAskAI?.(menu.node.path);
                  setMenu(null);
                }}
              >
                问 AI
              </button>
              <button
                onClick={() => {
                  setDialog({ kind: 'rename', node: menu.node });
                  setMenu(null);
                }}
              >
                重命名
              </button>
              <button
                className="danger"
                onClick={() => {
                  setDialog({ kind: 'delete', node: menu.node });
                  setMenu(null);
                }}
              >
                删除
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setDialog({ kind: 'newFile', dirPath: menu.node.path });
                  setMenu(null);
                }}
              >
                新建文件
              </button>
              <button
                onClick={() => {
                  setDialog({ kind: 'newFolder', dirPath: menu.node.path });
                  setMenu(null);
                }}
              >
                新建文件夹
              </button>
              <button
                onClick={() => {
                  onAskAI?.(menu.node.path);
                  setMenu(null);
                }}
              >
                问 AI
              </button>
              {!menu.isRoot ? (
                <button
                  onClick={() => {
                    setDialog({ kind: 'rename', node: menu.node });
                    setMenu(null);
                  }}
                >
                  重命名
                </button>
              ) : null}
              {!menu.isRoot ? (
                <button
                  className="danger"
                  onClick={() => {
                    setDialog({ kind: 'delete', node: menu.node });
                    setMenu(null);
                  }}
                >
                  删除
                </button>
              ) : null}
              {menu.isRoot && onRemoveRoot ? (
                <button
                  className="danger"
                  onClick={() => {
                    onRemoveRoot(menu.node.name);
                    setMenu(null);
                  }}
                >
                  移除文件夹
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {dialog?.kind === 'newFile' || dialog?.kind === 'newFolder' ? (
        <PromptDialog
          title={dialog.kind === 'newFile' ? '新建文件' : '新建文件夹'}
          initial=""
          placeholder={
            dialog.kind === 'newFile' ? '文件名，如 index.ts' : '文件夹名'
          }
          onSubmit={(name) => void createEntry(dialog.kind, dialog.dirPath, name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'rename' ? (
        <PromptDialog
          title="重命名"
          initial={dialog.node.name}
          onSubmit={(name) => void renameEntry(dialog.node, name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'delete' ? (
        <ConfirmDialog
          title="删除"
          message={`确定删除 ${dialog.node.path}？`}
          onConfirm={() => void deleteEntry(dialog.node)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
