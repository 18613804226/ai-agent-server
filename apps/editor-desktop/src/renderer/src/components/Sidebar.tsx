import { FileTree, FolderIcon } from './FileTree';
import type { WorkspaceNode, WorkspaceRootInfo } from '../mode/types';

/** 左侧工作区栏：根目录操作 + 文件树 */
export function Sidebar({
  workspaceRoot,
  roots,
  nodes,
  activeFile,
  onOpenFolder,
  onRefresh,
  onClearWorkspace,
  onOpenFile,
  onRemoveRoot,
  onAskAI,
  onFileDeleted,
  onError,
}: {
  workspaceRoot: string;
  roots: WorkspaceRootInfo[];
  nodes: WorkspaceNode[];
  activeFile: string;
  onOpenFolder: () => void;
  onRefresh: () => void;
  onClearWorkspace: () => void;
  onOpenFile: (path: string) => void;
  onRemoveRoot: (name: string) => void;
  onAskAI: (path: string, selection?: string) => void;
  onFileDeleted: (path: string) => void;
  onError: (msg: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-root">
        <span className="sidebar-root-name" title={workspaceRoot}>
          <FolderIcon />
          {roots.length ? `${roots.length} 个文件夹` : '未选择工作区'}
        </span>
        <div className="sidebar-root-actions">
          <button
            type="button"
            className="icon-btn"
            title="添加文件夹"
            aria-label="添加文件夹"
            onClick={onOpenFolder}
          >
            <svg
              viewBox="0 0 16 16"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z" />
              <path d="M8 7.5v3M6.5 9h3" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-btn"
            title="刷新"
            aria-label="刷新"
            onClick={onRefresh}
          >
            <svg
              viewBox="0 0 16 16"
              width="20"
              height="20"
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
          {roots.length ? (
            <button
              type="button"
              className="icon-btn"
              title="清空工作区"
              aria-label="清空工作区"
              onClick={onClearWorkspace}
            >
              <svg
                viewBox="0 0 16 16"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
      <FileTree
        nodes={nodes}
        activePath={activeFile}
        onOpen={onOpenFile}
        onRemoveRoot={onRemoveRoot}
        onAskAI={onAskAI}
        onRefresh={onRefresh}
        onDeleted={onFileDeleted}
        onError={onError}
      />
    </aside>
  );
}
