import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { ChatPanel } from './components/ChatPanel';
import type { ChatSession } from './components/ChatMessage';
import type { CodeEditorHandle } from './components/CodeEditor';
import { EditorPane } from './components/EditorPane';
import { QuickOpen } from './components/QuickOpen';
import { Sidebar } from './components/Sidebar';
import { SettingsModal } from './components/SettingsModal';
import { diffLines } from './diff';
import { useAgentRun, type AgentBackend } from './hooks/useAgentRun';
import { useEditorTabs } from './hooks/useEditorTabs';
import { useSettings } from './hooks/useSettings';
import { useWorkspace } from './hooks/useWorkspace';
import { useMode } from './mode/ModeContext';
import { LocalTransport, LocalWorkspace } from './mode/local';
import { RemoteTransport } from './mode/remote';
import type {
  AgentMode,
  AgentTransport,
  ApprovalPreview,
  FileChange,
  WorkspaceProvider,
} from './mode/types';
import { useTheme, type Theme } from './theme/ThemeContext';

/** 顶栏主题按钮图标：暗色时显示太阳（点了变亮），亮色时显示月亮 */
function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === 'dark' ? (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  ) : (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function createBackend(mode: AgentMode): {
  transport: AgentTransport;
  workspace: WorkspaceProvider;
} {
  // 两种模式都编辑本地项目：只有编排器位置不同
  return {
    transport: mode === 'local' ? new LocalTransport() : new RemoteTransport(),
    workspace: new LocalWorkspace(),
  };
}

export function App() {
  const { mode, setMode } = useMode();
  const { theme, toggleTheme } = useTheme();
  const backend = useMemo(() => createBackend(mode), [mode]);

  const [activeDiff, setActiveDiff] = useState<FileChange | null>(null);
  const [error, setError] = useState('');
  /** 聊天任务（多会话） */
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** 内置浏览器预览地址；null 表示未打开 */
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  /** 数据库面板是否打开 */
  const [databaseOpen, setDatabaseOpen] = useState(false);
  /** 浏览器标签是否处于激活（可与文件标签切换） */
  const [browserTabActive, setBrowserTabActive] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [streamingEditPath, setStreamingEditPath] = useState<string | null>(
    null,
  );
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(localStorage.getItem('editor_sidebar_width')) || 260,
  );
  const [chatWidth, setChatWidth] = useState(
    () => Number(localStorage.getItem('editor_chat_width')) || 400,
  );
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<CodeEditorHandle | null>(null);
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  /** 更新当前会话（消息/输入/图片）；patch 可以是值或基于最新会话的函数 */
  const updateSession = useCallback(
    (
      patch:
        | Partial<ChatSession>
        | ((prev: ChatSession) => Partial<ChatSession>),
    ) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeId) return s;
          const p = typeof patch === 'function' ? patch(s) : patch;
          return { ...s, ...p, updatedAt: Date.now() };
        }),
      );
    },
    [activeId],
  );

  const openBrowser = useCallback((url: string) => {
    setBrowserUrl(url || 'http://localhost:3000');
    setBrowserTabActive(true);
  }, []);
  const closeBrowser = useCallback(() => {
    setBrowserUrl(null);
    setBrowserTabActive(false);
  }, []);

  const activeSession: ChatSession =
    sessions.find((s) => s.id === activeId) ?? {
      id: '',
      title: '',
      messages: [],
      input: '',
      images: [],
      createdAt: 0,
      updatedAt: 0,
    };

  const {
    editorTabs,
    setEditorTabs,
    tabContextMenu,
    setTabContextMenu,
    tabClosePrompt,
    setTabClosePrompt,
    tabCloseSaving,
    tabCloseError,
    activeFile,
    setActiveFile,
    fileContent,
    setFileContentState,
    savedContent,
    setSavedContentState,
    setFileContent,
    setSavedContent,
    openFile,
    removeEditorTabs,
    requestCloseEditorTabs,
    respondToTabClosePrompt,
    selectEditorTab,
    saveCurrent,
    saveAllDirty,
    dirty,
  } = useEditorTabs({ backend, setActiveDiff, setError });

  const editorTabsRef = useRef(editorTabs);
  editorTabsRef.current = editorTabs;
  /** 始终指向最新 activeFile，避免事件回调里拿到闭包旧值 */
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  const {
    messages,
    streaming,
    changes,
    setChanges,
    pendingApproval,
    runState,
    setRunState,
    checkpoint,
    setCheckpoint,
    elapsedMs,
    send,
    stop,
    pauseRun,
    cancelRun,
    resumeRun,
    respondApproval,
    undoLastRun,
  } = useAgentRun({
    backend,
    mode,
    session: activeSession,
    updateSession,
    activeFile,
    fileContent,
    editorRef,
    activeFileRef,
    editorTabsRef,
    setActiveFile,
    setFileContentState,
    setSavedContentState,
    setEditorTabs,
    setStreamingEditPath,
    setFileContent,
    setSavedContent,
    setActiveDiff,
    setError,
    reloadRef,
    onBrowserOpen: openBrowser,
  });

  const {
    workspaceRoot,
    roots,
    nodes,
    reload,
    openFolder,
    removeRoot,
    clearWorkspace,
  } = useWorkspace({
    backend,
    setActiveFile,
    setFileContentState,
    setSavedContentState,
    setEditorTabs,
    setActiveDiff,
    setChanges,
    updateSession,
    setError,
  });

  // 把工作区重载同步给 agent-run（避免循环依赖）
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  const {
    config,
    providerStatus,
    modelOptions,
    modelGroups,
    modelConfigured,
    currentModel,
    saveConfig,
    updateModel,
    toggleApproval,
    mentionFiles,
  } = useSettings({ backend, mode, nodes, reload, setError });

  // 启动时加载会话
  useEffect(() => {
    void window.electron.chat
      .getSessions()
      .then((h) => {
        if (Array.isArray(h) && h.length) {
          setSessions(h as ChatSession[]);
          setActiveId((h as ChatSession[])[0].id);
        } else {
          const id = crypto.randomUUID();
          setSessions([
            {
              id,
              title: '新任务',
              messages: [],
              input: '',
              images: [],
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ]);
          setActiveId(id);
        }
      })
      .catch(() => {});
  }, []);

  // 兜底：如果 activeId 为空但已有会话，自动选中第一个
  useEffect(() => {
    if (!activeId && sessions.length) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId]);

  // 会话变化时落盘（debounce）
  useEffect(() => {
    if (!sessions.length) return;
    if (process.env.NODE_ENV === 'development') {
      console.log(
        '[chat] 保存会话',
        sessions.length,
        '当前消息数',
        sessions.find((s) => s.id === activeId)?.messages.length ?? 0,
      );
    }
    const t = setTimeout(() => {
      void window.electron.chat.saveSessions(sessions);
    }, 500);
    return () => clearTimeout(t);
  }, [sessions, activeId]);

  const createSession = () => {
    const id = crypto.randomUUID();
    setSessions((prev) => [
      ...prev,
      {
        id,
        title: '新任务',
        messages: [],
        input: '',
        images: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    setActiveId(id);
  };

  const deleteSession = (id: string) => {
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    if (activeId === id) setActiveId(next[0]?.id ?? '');
  };

  useEffect(() => {
    void backend.transport.getRunState?.().then((info) => {
      setRunState(info.state);
      setCheckpoint(info.checkpoint);
    });
  }, [backend.transport, setRunState, setCheckpoint]);

  useEffect(() => {
    if (!tabContextMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.editor-tab-context-menu')
      ) {
        return;
      }
      setTabContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTabContextMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    localStorage.setItem('editor_sidebar_width', String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem('editor_chat_width', String(chatWidth));
  }, [chatWidth]);

  const startDrag = (
    event: ReactMouseEvent,
    target: 'sidebar' | 'chat',
  ) => {
    event.preventDefault();
    const startX = event.clientX;
    const startSidebar = sidebarWidth;
    const startChat = chatWidth;
    const min = target === 'sidebar' ? 180 : 280;
    const max = target === 'sidebar' ? 480 : 720;

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startX;
      if (target === 'sidebar') {
        setSidebarWidth(Math.min(max, Math.max(min, startSidebar + dx)));
      } else {
        setChatWidth(Math.min(max, Math.max(min, startChat - dx)));
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const askAI = (path: string, selection?: string) => {
    const selectedCode = selection?.trim();
    const context = selectedCode
      ? `请帮我分析这段代码：\n${selectedCode}\n\n`
      : '';
    const v = activeSession.input;
    const separator = v && !v.endsWith('\n') ? '\n' : '';
    updateSession({ input: `${v}${separator}${context}@${path} ` });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /** 应用 diff 块审批结果：写回文件并同步改动记录与编辑器 */
  const applyDiff = async (path: string, content: string) => {
    try {
      await backend.workspace.writeFile?.(path, content);
    } catch (e: any) {
      setError(e?.message || String(e));
      return;
    }
    setChanges((prev) =>
      prev.map((c) => (c.path === path ? { ...c, after: content } : c)),
    );
    // 同步更新当前对比对象，否则再次应用会基于旧的 after
    setActiveDiff((prev) =>
      prev && prev.path === path ? { ...prev, after: content } : prev,
    );
    if (activeFile === path) {
      setFileContent(content);
      setSavedContent(content);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveCurrent();
      } else if (mod && e.key === '`') {
        e.preventDefault();
        setTerminalOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setQuickOpen(true);
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === 'Escape') {
        setQuickOpen(false);
        setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveCurrent]);

  return (
    <div className="app">
      <header className="topbar">
        <button
          type="button"
          className="brand"
          title="回到欢迎页"
          onClick={() => {
            setActiveFile('');
            setActiveDiff(null);
          }}
        >
          AI <span>Editor</span>
        </button>
        <button className="ghost" onClick={() => void openFolder()}>
          打开文件夹
        </button>
        <button className="ghost" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
        <button
          className="ghost"
          onClick={() => setTerminalOpen((v) => !v)}
        >
          终端
        </button>
        <button
          className="ghost"
          onClick={() =>
            browserUrl ? closeBrowser() : openBrowser('http://localhost:3000')
          }
        >
          浏览器
        </button>
        <button
          className="ghost"
          onClick={() => setDatabaseOpen((v) => !v)}
        >
          数据库
        </button>
        <div className="root-label" title={workspaceRoot}>
          {roots.length > 1
            ? `${roots.length} 个文件夹`
            : workspaceRoot || '未选择工作区'}
        </div>
        <div className="mode-switch">
          <button
            className={mode === 'local' ? 'active' : ''}
            onClick={() => setMode('local')}
          >
            本地
          </button>
          <button
            className={mode === 'remote' ? 'active' : ''}
            onClick={() => setMode('remote')}
          >
            云端
          </button>
        </div>
        <button
          className="ghost theme-toggle"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
          aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
        >
          <ThemeIcon theme={theme} />
          {theme === 'dark' ? '亮色' : '暗色'}
        </button>
      </header>

      {!modelConfigured && mode === 'local' ? (
        <div className="banner">
          没有可用模型：请在环境变量里配置至少一个提供商的 API Key（例如
          GLM_API_KEY）。
        </div>
      ) : null}
      {error ? <div className="banner">⚠️ {error}</div> : null}

      <div
        className="layout"
        style={{
          gridTemplateColumns: `${sidebarOpen ? sidebarWidth : 0}px ${sidebarOpen ? 4 : 0
            }px minmax(0, 1fr) 4px ${chatWidth}px`,
        }}
      >
        {sidebarOpen ? (
          <>
            <Sidebar
              workspaceRoot={workspaceRoot}
              roots={roots}
              nodes={nodes}
              activeFile={activeFile}
              onOpenFolder={() => void openFolder()}
              onRefresh={() => void reload()}
              onClearWorkspace={() => void clearWorkspace()}
              onOpenFile={openFile}
              onRemoveRoot={removeRoot}
              onAskAI={askAI}
              onFileDeleted={(path) => {
                const remainingTabs = editorTabs.filter(
                  (tab) => tab.path !== path && !tab.path.startsWith(path + '/'),
                );
                setEditorTabs(remainingTabs);
                if (
                  activeFile === path ||
                  activeFile.startsWith(path + '/')
                ) {
                  const nextTab = remainingTabs[0];
                  setActiveFile(nextTab?.path ?? '');
                  setFileContentState(nextTab?.content ?? '');
                  setSavedContentState(nextTab?.savedContent ?? '');
                  setActiveDiff(null);
                }
              }}
              onError={(msg) => setError(msg)}
            />

            <div
              className="resizer"
              role="separator"
              aria-orientation="vertical"
              onMouseDown={(e) => startDrag(e, 'sidebar')}
            />
          </>
        ) : null}

        <EditorPane
          editorTabs={editorTabs}
          activeFile={activeFile}
          activeDiff={activeDiff}
          fileContent={fileContent}
          streamingEditPath={streamingEditPath}
          tabContextMenu={tabContextMenu}
          terminalOpen={terminalOpen}
          editorRef={editorRef}
          onSelectTab={(path) => {
            setBrowserTabActive(false);
            void selectEditorTab(path);
          }}
          onRequestCloseTabs={requestCloseEditorTabs}
          onTabContextMenu={(menu) => setTabContextMenu(menu)}
          onCloseDiff={() => setActiveDiff(null)}
          onEditorChange={setFileContent}
          onAskAI={askAI}
          onCloseTerminal={() => setTerminalOpen(false)}
          onApplyDiff={(path, content) => void applyDiff(path, content)}
          browserUrl={browserUrl}
          onCloseBrowser={closeBrowser}
          browserTabActive={browserTabActive}
          onSelectBrowserTab={() => setBrowserTabActive(true)}
          onOpenBrowser={openBrowser}
          databaseOpen={databaseOpen}
          onCloseDatabase={() => setDatabaseOpen(false)}
        />

        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={(e) => startDrag(e, 'chat')}
        />

        <ChatPanel
          mode={mode}
          sessionId={activeSession.id}
          sessions={sessions}
          activeId={activeId}
          onCreateSession={createSession}
          onSelectSession={(id) => setActiveId(id)}
          onDeleteSession={deleteSession}
          messages={activeSession.messages}
          streaming={streaming}
          elapsedMs={elapsedMs}
          changes={changes}
          activeDiff={activeDiff}
          runState={runState}
          checkpoint={checkpoint}
          input={activeSession.input}
          setInput={(v) =>
            updateSession({
              input:
                typeof v === 'function'
                  ? (v as (prev: string) => string)(activeSession.input)
                  : v,
            })
          }
          images={activeSession.images}
          setImages={(v) =>
            updateSession({
              images:
                typeof v === 'function'
                  ? (v as (prev: string[]) => string[])(activeSession.images)
                  : v,
            })
          }
          mentionFiles={mentionFiles}
          config={config}
          currentModel={currentModel}
          modelGroups={modelGroups}
          modelOptions={modelOptions}
          rootsCount={roots.length}
          chatRef={chatRef}
          inputRef={inputRef}
          onSend={() => void send(currentModel)}
          onStop={stop}
          onPause={() => void pauseRun()}
          onResume={() => void resumeRun()}
          onCancel={() => void cancelRun()}
          onUndo={() => void undoLastRun()}
          onSelectDiff={setActiveDiff}
          onModelChange={(id) => void updateModel(id)}
          onToggleApproval={toggleApproval}
          onOpenBrowser={openBrowser}
          onApplyDiff={(path, content) => void applyDiff(path, content)}
          onSaveChanges={() => void saveAllDirty()}
        />
      </div>

      {quickOpen ? (
        <QuickOpen
          nodes={nodes}
          onSelect={(path) => void openFile(path)}
          onClose={() => setQuickOpen(false)}
        />
      ) : null}

      {settingsOpen && config ? (
        <SettingsModal
          config={config}
          status={providerStatus}
          onClose={() => setSettingsOpen(false)}
          onSave={saveConfig}
        />
      ) : null}

      {tabClosePrompt ? (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!tabCloseSaving) void respondToTabClosePrompt('cancel');
          }}
        >
          <div
            className="modal small"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-title">保存更改？</div>
            <div className="modal-body">
              <p className="confirm-message">
                “{tabClosePrompt.dirtyPaths[tabClosePrompt.index]}”有未保存的更改。
                要在关闭前保存吗？
              </p>
              {tabCloseError ? (
                <div className="modal-error">⚠️ {tabCloseError}</div>
              ) : null}
            </div>
            <div className="modal-actions">
              <button
                className="ghost"
                disabled={tabCloseSaving}
                onClick={() => void respondToTabClosePrompt('cancel')}
              >
                取消
              </button>
              <button
                className="ghost"
                disabled={tabCloseSaving}
                onClick={() => void respondToTabClosePrompt('discard')}
              >
                不保存
              </button>
              <button
                disabled={tabCloseSaving}
                onClick={() => void respondToTabClosePrompt('save')}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingApproval ? (
        <div className="modal-overlay">
          <div className="approval-modal">
            <div className="modal-title">等待确认</div>
            <div className="approval-tool">{pendingApproval.toolName}</div>
            {(pendingApproval.preview?.length
              ? pendingApproval.preview
              : ([
                {
                  kind: 'command',
                  command: JSON.stringify(pendingApproval.args),
                },
              ] as ApprovalPreview[])
            ).map((preview, index) => (
              <div key={index} className="approval-preview">
                {preview.path ? (
                  <div className="approval-path">
                    {preview.kind === 'rename' && preview.from
                      ? `${preview.from} → ${preview.path}`
                      : preview.path}
                  </div>
                ) : null}
                {preview.kind === 'command' ? (
                  <pre className="approval-args">{preview.command}</pre>
                ) : (
                  <div className="approval-diff">
                    {diffLines(preview.before ?? '', preview.after ?? '').map(
                      (line, lineIndex) => (
                        <div
                          key={lineIndex}
                          className={`diff-line diff-${line.type}`}
                        >
                          <span className="diff-sign">
                            {line.type === 'add'
                              ? '+'
                              : line.type === 'del'
                                ? '-'
                                : ' '}
                          </span>
                          <span className="diff-text">{line.text || ' '}</span>
                        </div>
                      ),
                    )}
                  </div>
                )}
              </div>
            ))}
            <div className="approval-actions">
              <button
                type="button"
                onClick={() => respondApproval(true)}
              >
                允许
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => respondApproval(false)}
              >
                拒绝
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
