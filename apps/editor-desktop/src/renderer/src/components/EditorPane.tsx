import { useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { DiffView } from './DiffView';
import { Terminal } from './Terminal';
import { Welcome } from './Welcome';
import type { FileChange } from '../mode/types';
import type { EditorTab } from '../hooks/useAgentRun';

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function fileIconKind(path: string): string {
  const extension = fileName(path).split('.').pop()?.toLowerCase();
  if (['tsx', 'jsx'].includes(extension ?? '')) return 'react';
  if (['ts', 'mts', 'cts'].includes(extension ?? '')) return 'typescript';
  if (['js', 'mjs', 'cjs'].includes(extension ?? '')) return 'javascript';
  if (['json', 'jsonc'].includes(extension ?? '')) return 'json';
  if (['css', 'scss', 'less'].includes(extension ?? '')) return 'style';
  if (['md', 'mdx'].includes(extension ?? '')) return 'markdown';
  if (['html', 'htm'].includes(extension ?? '')) return 'html';
  return 'default';
}

function fileIconLabel(path: string): string {
  switch (fileIconKind(path)) {
    case 'react':
      return '<>';
    case 'typescript':
      return 'TS';
    case 'javascript':
      return 'JS';
    case 'json':
      return '{}';
    case 'style':
      return '#';
    case 'markdown':
      return 'M';
    case 'html':
      return '5';
    default:
      return '·';
  }
}

/** 中间编辑区：标签栏 + 编辑器/对比/欢迎页 + 终端 */
export function EditorPane({
  editorTabs,
  activeFile,
  activeDiff,
  fileContent,
  streamingEditPath,
  tabContextMenu,
  terminalOpen,
  editorRef,
  onSelectTab,
  onRequestCloseTabs,
  onTabContextMenu,
  onCloseDiff,
  onEditorChange,
  onAskAI,
  onCloseTerminal,
}: {
  editorTabs: EditorTab[];
  activeFile: string;
  activeDiff: FileChange | null;
  fileContent: string;
  streamingEditPath: string | null;
  tabContextMenu: { x: number; y: number; path: string } | null;
  terminalOpen: boolean;
  editorRef: RefObject<CodeEditorHandle | null>;
  onSelectTab: (path: string) => void;
  onRequestCloseTabs: (paths: string[]) => void;
  onTabContextMenu: (menu: { x: number; y: number; path: string } | null) => void;
  onCloseDiff: () => void;
  onEditorChange: (content: string) => void;
  onAskAI: (path: string, selection?: string) => void;
  onCloseTerminal: () => void;
}) {
  const [terminalHeight, setTerminalHeight] = useState(
    () => Number(localStorage.getItem('editor_terminal_height')) || 240,
  );

  /** 拖拽调整终端高度 */
  const startTerminalResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = terminalHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      setTerminalHeight(Math.min(520, Math.max(120, startHeight + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      setTerminalHeight((h) => {
        localStorage.setItem('editor_terminal_height', String(h));
        return h;
      });
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <main className="editor">
      <div className="editor-tabbar">
        <div className="editor-tabs" role="tablist" aria-label="打开的文件">
          {editorTabs.length ? (
            editorTabs.map((tab) => {
              const isActive = activeFile === tab.path && !activeDiff;
              const isDirty = tab.content !== tab.savedContent;
              return (
                <div
                  key={tab.path}
                  className={`editor-tab-item ${isActive ? 'active' : ''}`}
                  role="presentation"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onTabContextMenu({
                      x: Math.min(event.clientX, window.innerWidth - 180),
                      y: Math.min(event.clientY, window.innerHeight - 150),
                      path: tab.path,
                    });
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className="editor-tab-button"
                    title={tab.path}
                    onClick={() => onSelectTab(tab.path)}
                  >
                    <span
                      className={`editor-file-icon editor-file-icon-${fileIconKind(
                        tab.path,
                      )}`}
                      aria-hidden="true"
                    >
                      {fileIconLabel(tab.path)}
                    </span>
                    <span className="editor-tab-label">
                      {fileName(tab.path)}
                    </span>
                    {isDirty ? (
                      <span className="editor-tab-dirty" aria-label="未保存">
                        ●
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="editor-tab-close"
                    title={`关闭 ${fileName(tab.path)}`}
                    aria-label={`关闭 ${tab.path}`}
                    onClick={() => onRequestCloseTabs([tab.path])}
                  >
                    ×
                  </button>
                </div>
              );
            })
          ) : activeDiff ? (
            <div className="editor-tab-item active">
              <span className="editor-tab-button editor-tab-label">
                diff: {fileName(activeDiff.path)}
              </span>
              <button
                type="button"
                className="editor-tab-close"
                title="关闭对比"
                aria-label="关闭对比"
                onClick={onCloseDiff}
              >
                ×
              </button>
            </div>
          ) : (
            <div className="editor-tab-item active">
              <span className="editor-tab-button editor-tab-label">
                欢迎
              </span>
            </div>
          )}
          {editorTabs.length > 0 && activeDiff ? (
            <div className="editor-tab-item active">
              <span className="editor-tab-button editor-tab-label">
                diff: {fileName(activeDiff.path)}
              </span>
              <button
                type="button"
                className="editor-tab-close"
                title="关闭对比"
                aria-label="关闭对比"
                onClick={onCloseDiff}
              >
                ×
              </button>
            </div>
          ) : null}
        </div>
        {tabContextMenu ? (
          <div
            className="context-menu editor-tab-context-menu"
            style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              onClick={() => {
                onTabContextMenu(null);
                onRequestCloseTabs([tabContextMenu.path]);
              }}
            >
              关闭当前
            </button>
            <button
              type="button"
              onClick={() => {
                onTabContextMenu(null);
                onRequestCloseTabs(editorTabs.map((tab) => tab.path));
              }}
            >
              关闭所有
            </button>
            <div className="context-menu-separator" />
            <button
              type="button"
              disabled={
                !editorTabs.some(
                  (tab) => tab.content === tab.savedContent,
                )
              }
              onClick={() => {
                onTabContextMenu(null);
                onRequestCloseTabs(
                  editorTabs
                    .filter((tab) => tab.content === tab.savedContent)
                    .map((tab) => tab.path),
                );
              }}
            >
              关闭已保存
            </button>
          </div>
        ) : null}
        {activeDiff ? (
          <div className="editor-actions">
            <button className="ghost small" onClick={onCloseDiff}>
              关闭对比
            </button>
          </div>
        ) : null}
      </div>
      <div className="editor-content">
        {streamingEditPath ? (
          <div className="streaming-banner">
            <span className="streaming-dot" />
            AI 正在编辑 {streamingEditPath}…
          </div>
        ) : null}
        {activeDiff ? (
          <DiffView change={activeDiff} />
        ) : activeFile ? (
          <CodeEditor
            ref={editorRef}
            path={activeFile}
            value={fileContent}
            onChange={onEditorChange}
            onAskAI={onAskAI}
          />
        ) : (
          <Welcome />
        )}
      </div>
      {terminalOpen ? (
        <>
          <div
            className="terminal-resize"
            onMouseDown={startTerminalResize}
            title="拖拽调整终端高度"
          />
          <Terminal onClose={onCloseTerminal} height={terminalHeight} />
        </>
      ) : null}
    </main>
  );
}
