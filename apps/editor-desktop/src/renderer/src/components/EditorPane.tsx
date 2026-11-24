import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { BrowserPanel } from './BrowserPanel';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { DatabasePanel } from './DatabasePanel';
import { DiffView } from './DiffView';
import { Terminal } from './Terminal';
import { Welcome } from './Welcome';
import type { FileChange } from '../mode/types';
import type { EditorTab } from '../hooks/useAgentRun';

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** 扩展名 → 图标类型 */
const ICON_KINDS: Record<string, string> = {
  tsx: 'react',
  jsx: 'react',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'style',
  scss: 'style',
  less: 'style',
  md: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  go: 'go',
  java: 'java',
  py: 'python',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  rs: 'rust',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  bat: 'shell',
  cmd: 'shell',
  sql: 'sql',
  vue: 'vue',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  toml: 'toml',
};

/** 图标类型 → 显示文本 */
const ICON_LABELS: Record<string, string> = {
  react: '<>',
  typescript: 'TS',
  javascript: 'JS',
  json: '{}',
  style: '#',
  markdown: 'M',
  html: '5',
  go: 'GO',
  java: 'JAVA',
  python: 'PY',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  php: 'PHP',
  ruby: 'RB',
  rust: 'RS',
  swift: 'Swift',
  kotlin: 'KT',
  shell: 'SH',
  sql: 'SQL',
  vue: 'Vue',
  yaml: 'YML',
  xml: 'XML',
  toml: 'TOML',
};

function fileIconKind(path: string): string {
  const extension = fileName(path).split('.').pop()?.toLowerCase() ?? '';
  return ICON_KINDS[extension] ?? 'default';
}

function fileIconLabel(path: string): string {
  return ICON_LABELS[fileIconKind(path)] ?? '·';
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
  onOpenDemoWorkspace,
  onTabContextMenu,
  onCloseDiff,
  onApplyDiff,
  onRevertDiff,
  onEditorChange,
  onAskAI,
  onCloseTerminal,
  browserUrl,
  onCloseBrowser,
  browserTabActive,
  onSelectBrowserTab,
  onOpenBrowser,
  databaseOpen,
  databaseTabActive,
  onSelectDatabaseTab,
  onCloseDatabase,
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
  onOpenDemoWorkspace: () => void;
  onTabContextMenu: (menu: { x: number; y: number; path: string } | null) => void;
  onCloseDiff: () => void;
  onRevertDiff?: (change: FileChange) => void;
  onEditorChange: (content: string) => void;
  onAskAI: (path: string, selection?: string) => void;
  onCloseTerminal: () => void;
  onApplyDiff: (path: string, content: string) => void;
  browserUrl: string | null;
  onCloseBrowser: () => void;
  browserTabActive: boolean;
  onSelectBrowserTab: () => void;
  onOpenBrowser: (url: string) => void;
  databaseOpen: boolean;
  databaseTabActive: boolean;
  onSelectDatabaseTab: () => void;
  onCloseDatabase: () => void;
}) {
  const [terminalHeight, setTerminalHeight] = useState(
    () => Number(localStorage.getItem('editor_terminal_height')) || 240,
  );
  const tabsRef = useRef<HTMLDivElement>(null);

  // 标签栏支持鼠标滚轮横向滚动（隐藏滚动条时仍可滑动）
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
        <div
          className="editor-tabs"
          role="tablist"
          aria-label="打开的文件"
          ref={tabsRef}
        >
          {editorTabs.map((tab) => {
            const isActive =
              !browserTabActive &&
              !databaseTabActive &&
              activeFile === tab.path &&
              !activeDiff;
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
          })}
          {activeDiff && !browserTabActive && !databaseTabActive ? (
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
          {browserUrl ? (
            <div
              className={`editor-tab-item${
                browserTabActive ? ' active' : ''
              }`}
            >
              <button
                type="button"
                className="editor-tab-button"
                onClick={onSelectBrowserTab}
              >
                <span className="editor-tab-label">浏览器</span>
              </button>
              <button
                type="button"
                className="editor-tab-close"
                title="关闭浏览器"
                aria-label="关闭浏览器"
                onClick={onCloseBrowser}
              >
                ×
              </button>
            </div>
          ) : null}
          {databaseOpen ? (
            <div
              className={`editor-tab-item${databaseTabActive ? ' active' : ''}`}
            >
              <button
                type="button"
                className="editor-tab-button"
                onClick={onSelectDatabaseTab}
              >
                <span className="editor-tab-label">数据库</span>
              </button>
              <button
                type="button"
                className="editor-tab-close"
                title="关闭数据库"
                aria-label="关闭数据库"
                onClick={onCloseDatabase}
              >
                ×
              </button>
            </div>
          ) : null}
          {!editorTabs.length && !activeDiff && !browserUrl && !databaseOpen ? (
            <div className="editor-tab-item active">
              <span className="editor-tab-button editor-tab-label">
                欢迎
              </span>
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
      </div>
      <div className="editor-content">
        {databaseOpen && databaseTabActive ? (
          <DatabasePanel />
        ) : browserUrl && browserTabActive ? (
          <BrowserPanel initialUrl={browserUrl} onClose={onCloseBrowser} />
        ) : (
          <>
            {streamingEditPath ? (
              <div className="streaming-banner">
                <span className="streaming-dot" />
                AI 正在编辑 {streamingEditPath}…
              </div>
            ) : null}
            {activeDiff ? (
              <DiffView
                change={activeDiff}
                onApply={(content) => onApplyDiff?.(activeDiff.path, content)}
                onRevert={onRevertDiff}
              />
            ) : activeFile ? (
              <CodeEditor
                ref={editorRef}
                path={activeFile}
                value={fileContent}
                onChange={onEditorChange}
                onAskAI={onAskAI}
              />
            ) : (
              <Welcome onOpenDemo={onOpenDemoWorkspace} />
            )}
          </>
        )}
      </div>
      {terminalOpen ? (
        <>
          <div
            className="terminal-resize"
            onMouseDown={startTerminalResize}
            title="拖拽调整终端高度"
          />
          <Terminal
            onClose={onCloseTerminal}
            height={terminalHeight}
            onOpenBrowser={onOpenBrowser}
          />
        </>
      ) : null}
    </main>
  );
}
