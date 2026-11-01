import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ChangeEvent,
    type MouseEvent as ReactMouseEvent,
  } from 'react';
  import { CodeEditor, type CodeEditorHandle } from './components/CodeEditor';
  import { DiffView } from './components/DiffView';
  import { FileTree, FolderIcon } from './components/FileTree';
  import { MentionPicker } from './components/MentionPicker';
  import { ModelSelect } from './components/ModelSelect';
  import { QuickOpen } from './components/QuickOpen';
  import { SettingsModal } from './components/SettingsModal';
  import { Terminal } from './components/Terminal';
  import { Welcome } from './components/Welcome';
  import { changeLabel, diffLines } from './diff';
  import type { RunCheckpointInfo } from './electron';
  import { extractMentions, flattenFiles } from './files';
  import { useMode } from './mode/ModeContext';
  import { DEFAULT_LOCAL_MODEL } from './models';
  import { LocalTransport, LocalWorkspace } from './mode/local';
  import { RemoteTransport } from './mode/remote';
  import type {
    AgentMode,
    AgentTransport,
    AppConfig,
    ApprovalPreview,
    ChatEvent,
    FileChange,
    FileEdit,
    ProviderStatus,
    WorkspaceNode,
    WorkspaceProvider,
    WorkspaceRootInfo,
  } from './mode/types';

/** 一次工具操作的结构化记录（读/写/编辑/终端等） */
interface ToolActivity {
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  /** 对应 tool_call 的本轮序号 */
  index?: number;
}

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thought?: string;
  /** 流式工具操作块：每个工具调用一条 */
  tools?: ToolActivity[];
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

/** 生成耗时格式化：<60s 显示 X.Xs，否则显示 m:ss */
function formatElapsed(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remainder = Math.floor(sec % 60);
  return `${min}:${remainder.toString().padStart(2, '0')}`;
}

/** 规范化文件路径：去掉前导斜杠/反斜杠，统一正斜杠（AI 入参常带 /） */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** 工具操作图标 */
function toolIcon(name: string): string {
  switch (name) {
    case 'read_file':
    case 'list_dir':
      return '📖';
    case 'write_file':
    case 'edit_file':
    case 'apply_patch':
      return '✏️';
    case 'delete_file':
      return '🗑️';
    case 'move_file':
      return '📦';
    case 'create_directory':
      return '📁';
    case 'search_files':
    case 'glob':
      return '🔍';
    case 'run_terminal':
      return '💻';
    case 'git_status':
    case 'git_diff':
      return '🌿';
    default:
      return '🔧';
  }
}

/** 工具操作摘要：把入参提炼成一行可读描述 */
function toolSummary(name: string, args?: Record<string, unknown>): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'read_file':
      return `读取 ${s(a.path)}`;
    case 'write_file':
      return `写入 ${s(a.path)}`;
    case 'edit_file':
      return `编辑 ${s(a.path)}`;
    case 'apply_patch': {
      const edits = Array.isArray(a.edits) ? (a.edits as unknown[]) : [];
      return `应用补丁 ${edits.length} 处`;
    }
    case 'delete_file':
      return `删除 ${s(a.path)}`;
    case 'move_file':
      return `移动 ${s(a.from)} → ${s(a.to)}`;
    case 'create_directory':
      return `创建目录 ${s(a.path)}`;
    case 'list_dir':
      return `列出 ${s(a.path)}`;
    case 'search_files':
      return `搜索 /${s(a.pattern)}/`;
    case 'glob':
      return `查找文件 ${s(a.pattern)}`;
    case 'run_terminal':
      return `执行 ${s(a.command)}`;
    case 'git_status':
      return 'git status';
    case 'git_diff':
      return `git diff ${s(a.path ?? '')}`.trim();
    default:
      return name;
  }
}

export function App() {
  const { mode, setMode } = useMode();
  const backend = useMemo(() => createBackend(mode), [mode]);

  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [roots, setRoots] = useState<WorkspaceRootInfo[]>([]);
  const [nodes, setNodes] = useState<WorkspaceNode[]>([]);
  const [activeFile, setActiveFile] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [mention, setMention] = useState<{
    query: string;
    start: number;
  } | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [activeDiff, setActiveDiff] = useState<FileChange | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{
    id: string;
    toolName: string;
    args: Record<string, unknown>;
    preview?: ApprovalPreview[];
  } | null>(null);
  const [runState, setRunState] = useState<string>('idle');
  const [checkpoint, setCheckpoint] = useState<RunCheckpointInfo | null>(null);
  const [savedContent, setSavedContent] = useState('');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [streamingEditPath, setStreamingEditPath] = useState<string | null>(
    null,
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(localStorage.getItem('editor_sidebar_width')) || 260,
  );
  const [chatWidth, setChatWidth] = useState(
    () => Number(localStorage.getItem('editor_chat_width')) || 400,
  );
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<CodeEditorHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 始终指向最新 activeFile，避免事件回调里拿到闭包旧值 */
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  const genStartRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 生成计时：streaming 期间每 100ms 更新一次耗时
  useEffect(() => {
    if (!streaming) return;
    genStartRef.current = Date.now();
    setElapsedMs(0);
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - genStartRef.current);
    }, 100);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [streaming]);

  useEffect(() => {
    void backend.transport.getRunState?.().then((info) => {
      setRunState(info.state);
      setCheckpoint(info.checkpoint);
    });
  }, [backend.transport]);

  const reload = useCallback(
    async (b = backend) => {
      try {
        setError('');
        const list = await b.workspace.roots();
        setRoots(list);
        setWorkspaceRoot(list[0]?.path || '');
        setNodes(await b.workspace.tree());
      } catch (e: any) {
        setError(e?.message || String(e));
        setNodes([]);
      }
    },
    [backend],
  );

  useEffect(() => {
    backend.transport.abort();
    setMessages([]);
    setActiveFile('');
    setFileContent('');
    setError('');
    setChanges([]);
    setActiveDiff(null);
    void reload(backend);
  }, [backend, reload]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages, changes]);

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

  useEffect(() => {
    void window.electron.config
      .get()
      .then(setConfig)
      .catch((e) => setError(e?.message || String(e)));
  }, []);

  const refreshProviders = useCallback(async () => {
    try {
      const s = await window.electron.providers.status();
      setProviderStatus(s.providers);
    } catch {
      setProviderStatus([]);
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const availableModels = useMemo(
    () =>
      providerStatus
        .filter((p) => p.hasKey)
        .flatMap((p) =>
          p.models.map((m) => ({
            id: m.id,
            label: m.name || m.id,
          })),
        ),
    [providerStatus],
  );

  const allModels = useMemo(
    () =>
      (config?.providers ?? []).flatMap((p) =>
      p.models.map((m) => ({
          id: m.id,
          label: m.name || m.id,
        })),
    ),
    [config],
  );

  const modelOptions = mode === 'local' ? availableModels : allModels;

  const modelGroups = useMemo(() => {
    const providers =
      mode === 'local'
        ? providerStatus.filter((p) => p.hasKey)
        : (config?.providers ?? []);
    return providers
      .map((p) => ({
        provider: p.name,
        models: p.models.map((m) => ({
          id: m.id,
          label: m.name || m.id,
        })),
      }))
      .filter((g) => g.models.length > 0);
  }, [mode, providerStatus, config]);
  const modelConfigured =
    !config || mode === 'remote' || availableModels.length > 0;

  const saveConfig = async (next: AppConfig) => {
    const saved = await window.electron.config.set(next);
    setConfig(saved);
    await refreshProviders();
    await reload(backend);
  };

  const currentModel =
    mode === 'local'
      ? config?.selectedModel || DEFAULT_LOCAL_MODEL
      : config?.remote.model ||
        config?.selectedModel ||
        DEFAULT_LOCAL_MODEL;

  const updateModel = async (model: string) => {
    if (!config) return;
    const next: AppConfig =
      mode === 'local'
        ? { ...config, selectedModel: model }
        : { ...config, remote: { ...config.remote, model } };
    const saved = await window.electron.config.set(next);
    setConfig(saved);
    await refreshProviders();
  };

  // 当前选中的本地模型没有 key 时，自动切到第一个可用模型
  useEffect(() => {
    if (!config || mode !== 'local') return;
    if (
      availableModels.length &&
      !availableModels.some((m) => m.id === config.selectedModel)
    ) {
      const next = { ...config, selectedModel: availableModels[0].id };
      void window.electron.config.set(next).then(setConfig);
    }
  }, [config, mode, availableModels]);

  const mentionFiles = useMemo(() => flattenFiles(nodes), [nodes]);
  const mentionResults = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const list = q
      ? mentionFiles.filter((f) => f.toLowerCase().includes(q))
      : mentionFiles;
    return list.slice(0, 20);
  }, [mention, mentionFiles]);
  const mentions = extractMentions(input);

  const handleInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    const pos = e.target.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    const match = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (match) {
      setMention({
        query: match[1],
        start: before.length - match[1].length - 1,
      });
      setMentionActive(0);
    } else {
      setMention(null);
    }
  };

  const selectMention = (path: string) => {
    if (!mention) return;
    const insert = `@${path} `;
    const start = mention.start;
    const end = start + 1 + mention.query.length;
    const next = input.slice(0, start) + insert + input.slice(end);
    setInput(next);
    setMention(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const pos = start + insert.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const removeMention = (path: string) => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\s)@${escaped}(?=\\s|$)`, 'g');
    setInput((v) => v.replace(re, '').replace(/\s{2,}/g, ' ').trimStart());
  };

  /** 「+」按钮：插入 @ 并打开文件选择 */
  const insertAt = () => {
    const next = `${input}${input && !input.endsWith(' ') ? ' ' : ''}@`;
    setInput(next);
    setMention({ query: '', start: next.length - 1 });
    setMentionActive(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  };

  const openFolder = async () => {
    if (!backend.workspace.open) return;
    try {
      await backend.workspace.open();
      await reload();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const removeRoot = async (name: string) => {
    const root = roots.find((r) => r.name === name);
    if (!root || !backend.workspace.removeRoot) return;
    try {
      await backend.workspace.removeRoot(root.path);
      await reload();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const askAI = (path: string) => {
    setInput((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}@${path} `);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const clearWorkspace = async () => {
    try {
      await backend.workspace.clear?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
    backend.transport.abort();
    setWorkspaceRoot('');
    setRoots([]);
    setNodes([]);
    setActiveFile('');
    setFileContent('');
    setSavedContent('');
    setActiveDiff(null);
    setChanges([]);
    setMessages([]);
    setError('');
  };

  const openFile = async (path: string) => {
    try {
      setActiveDiff(null);
      setActiveFile(path);
      const content = await backend.workspace.readFile(path);
      setFileContent(content);
      setSavedContent(content);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const dirty = Boolean(activeFile) && fileContent !== savedContent;

  const saveCurrent = useCallback(async () => {
    if (!activeFile || !backend.workspace.writeFile) return;
    try {
      await backend.workspace.writeFile(activeFile, fileContent);
      setSavedContent(fileContent);
      setError('');
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [activeFile, fileContent, backend]);

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

  /** 把 agent 事件应用到消息列表；本地/云端/断点续跑共用 */
  const applyAgentEvent = useCallback((ev: ChatEvent, assistantId: string) => {
    if (ev.type === 'approval_request') {
      setPendingApproval({
        id: ev.id ?? '',
        toolName: ev.toolName ?? '',
        args: ev.args ?? {},
      });
      return;
    }
    if (ev.type === 'done' && ev.changes) {
      setChanges(ev.changes);
    }
    // file_edit：在编辑器里一行一行往下刷（Cline 风格）
    if (ev.type === 'file_edit' && ev.edit) {
      const edit = ev.edit;
      const editPath = edit.path ? normalizePath(edit.path) : '';
      setStreamingEditPath(editPath || null);
      // 异步执行：不同文件时先切换并等待编辑器重建，避免竞态
      void (async () => {
        try {
          if (editPath && editPath !== activeFileRef.current) {
            setActiveFile(editPath);
            try {
              const content = await backend.workspace.readFile(editPath);
              setFileContent(content);
              setSavedContent(content);
            } catch {
              // 文件可能不存在（新建文件场景）
            }
            // 等 React 重渲染 + Monaco 编辑器重建完成
            await new Promise((r) => setTimeout(r, 250));
          }
          await editorRef.current?.applyStreamingEdit(edit);
          // 动画结束后同步内容到状态
          if (editPath) {
            const latest = editorRef.current?.getValue() ?? '';
            setFileContent(latest);
          }
        } finally {
          setStreamingEditPath(null);
        }
      })();
    }
    setMessages((m) =>
      m.map((msg) => {
        if (msg.id !== assistantId) return msg;
        switch (ev.type) {
          case 'thought':
            return {
              ...msg,
              thought: (msg.thought ?? '') + (ev.content ?? ''),
            };
          case 'content':
            return { ...msg, content: msg.content + (ev.content ?? '') };
          case 'tool_call':
            return {
              ...msg,
              tools: [
                ...(msg.tools ?? []),
                { name: ev.name ?? '', args: ev.args, index: ev.index },
              ],
            };
          case 'tool_result':
            return {
              ...msg,
              tools: (msg.tools ?? []).map((tool) =>
                tool.index === ev.index ? { ...tool, result: ev.result } : tool,
              ),
            };
          case 'error':
            return {
              ...msg,
              content: msg.content + `\n⚠️ ${ev.content ?? ''}`,
            };
          default:
            return msg;
        }
      }),
    );
  }, []);

  const send = async () => {
    const displayQuery = input.trim();
    if (!displayQuery || streaming) return;

    // @path 引用的文件内容一起带给 agent
    const mentionPaths = extractMentions(displayQuery);
    let agentQuery = displayQuery;
    if (mentionPaths.length) {
      const blocks: string[] = [];
      for (const path of mentionPaths) {
        try {
          const content = await backend.workspace.readFile(path);
          blocks.push(`--- ${path} ---\n${content.slice(0, 20000)}`);
        } catch {
          blocks.push(`--- ${path} ---\n（无法读取该文件）`);
        }
      }
      agentQuery = `${displayQuery}\n\n【引用文件】\n${blocks.join('\n\n')}`;
    }

    // 本轮之前的历史消息（本地模式需要显式带上；云端由后端按 session 读取）
    const history = messages
      .filter((m) => m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    setInput('');
    setMention(null);
    setChanges([]);
    setMessages((m) => [
      ...m,
      { id: crypto.randomUUID(), role: 'user', content: displayQuery },
    ]);
    setStreaming(true);
    setRunState('running');
    const assistantId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      { id: assistantId, role: 'assistant', content: '', thought: '' },
    ]);
    abortRef.current = new AbortController();

    // 编辑器上下文：当前文件、内容、选区，随本轮一起发给 agent
    const selection = editorRef.current?.getSelection() ?? '';
    const agentContext = activeFile
      ? {
          activeFile,
          activeContent: fileContent.slice(0, 20000),
          selection: selection || undefined,
        }
      : undefined;

    try {
      await backend.transport.run(
        agentQuery,
        (ev: ChatEvent) => applyAgentEvent(ev, assistantId),
        abortRef.current.signal,
        {
          // 云端也显式带模型，避免落到后端的付费级联
          model:
            mode === 'remote'
              ? config?.remote.model ||
                config?.selectedModel ||
                DEFAULT_LOCAL_MODEL
              : undefined,
          history,
          context: agentContext,
        },
      );
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setMessages((m) => [
          ...m,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `⚠️ ${e?.message || e}`,
          },
        ]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      void backend.transport.getRunState?.().then((info) => {
        setRunState(info.state);
        setCheckpoint(info.checkpoint);
      });
      void reload();
    }
  };

  const stop = () => {
    backend.transport.abort();
    abortRef.current?.abort();
  };

  const pauseRun = async () => {
    const info = await backend.transport.pause();
    setRunState(info.state);
    setCheckpoint(info.checkpoint);
  };

  const cancelRun = async () => {
    const info = await backend.transport.cancel();
    setRunState(info.state);
    setCheckpoint(info.checkpoint);
  };

  const resumeRun = async () => {
    const info = await backend.transport.getRunState();
    const cp = info.checkpoint;
    if (!cp) return;
    setMessages(
      cp.history.map((m) => ({ ...m, id: crypto.randomUUID() })),
    );
    setCheckpoint(cp);
    setRunState('running');
    setStreaming(true);
    const assistantId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      { id: assistantId, role: 'assistant', content: '', thought: '' },
    ]);
    abortRef.current = new AbortController();
    try {
      await backend.transport.resume?.(
        (ev) => applyAgentEvent(ev, assistantId),
        abortRef.current.signal,
      );
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setMessages((m) => [
          ...m,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `⚠️ ${e?.message || e}`,
          },
        ]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      const state = await backend.transport.getRunState?.();
      if (state) {
        setRunState(state.state);
        setCheckpoint(state.checkpoint);
      }
      void reload();
    }
  };

  const respondApproval = (approved: boolean) => {
    const request = pendingApproval;
    if (!request) return;
    setPendingApproval(null);
    void window.electron.agent.respondApproval(request.id, approved);
  };

  const undoLastRun = async () => {
    if (!changes.length) return;
    const result = await window.electron.agent.undoAgent();
    if (result.failed.length) {
      setError(`撤销失败：${result.failed.join('；')}`);
      return;
    }
    setChanges([]);
    setActiveDiff(null);
    if (activeFileRef.current) {
      try {
        const content = await backend.workspace.readFile(activeFileRef.current);
        setFileContent(content);
        setSavedContent(content);
      } catch {
        // 文件可能已被撤销删除
      }
    }
  };

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
          gridTemplateColumns: `${sidebarOpen ? sidebarWidth : 0}px ${
            sidebarOpen ? 4 : 0
          }px minmax(0, 1fr) 4px ${chatWidth}px`,
        }}
      >
        {sidebarOpen ? (
          <>
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
                onClick={() => void openFolder()}
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
              {roots.length ? (
                <button
                  type="button"
                  className="icon-btn"
                  title="清空工作区"
                  aria-label="清空工作区"
                  onClick={() => void clearWorkspace()}
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
            onOpen={openFile}
            onRemoveRoot={removeRoot}
            onAskAI={askAI}
            onRefresh={() => void reload()}
            onDeleted={(path) => {
              if (
                activeFile === path ||
                activeFile.startsWith(path + '/')
              ) {
                setActiveFile('');
                setFileContent('');
                setSavedContent('');
                setActiveDiff(null);
              }
            }}
            onError={(msg) => setError(msg)}
          />
        </aside>

        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={(e) => startDrag(e, 'sidebar')}
        />
          </>
        ) : null}

        <main className="editor">
          <div className="editor-tab">
            <span className="editor-tab-label">
              {activeDiff
                ? `diff: ${activeDiff.path}`
                : activeFile || '欢迎'}
              {dirty ? <span className="dirty-dot"> ●</span> : null}
            </span>
            <div className="editor-actions">
              {activeFile && !activeDiff ? (
                <button
                  className="ghost small"
                  onClick={() => void saveCurrent()}
                  disabled={!dirty}
                >
                  保存
                </button>
              ) : null}
              {activeDiff ? (
                <button
                  className="ghost small"
                  onClick={() => setActiveDiff(null)}
                >
                  关闭对比
                </button>
              ) : null}
            </div>
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
                onChange={setFileContent}
              />
            ) : (
              <Welcome />
            )}
          </div>
          {terminalOpen ? (
            <Terminal onClose={() => setTerminalOpen(false)} />
          ) : null}
        </main>

        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={(e) => startDrag(e, 'chat')}
        />

        <section className="chat">
          <div className="chat-header">
            AI 助手 · editor agent · {mode === 'local' ? '本地' : '云端'}
          </div>
          <div className="chat-body" ref={chatRef}>
            {messages.length === 0 && (
              <div className="muted chat-hint">
                试试：帮我看下工作区里有哪些文件 / 读一下 xxx 文件
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`msg msg-${m.role}`}>
                {m.thought ? <pre className="thought">{m.thought}</pre> : null}
                {m.tools?.map((t, i) => (
                  <div key={i} className="tool-activity">
                    <div className="tool-activity-head">
                      <span className="tool-icon">{toolIcon(t.name)}</span>
                      <span className="tool-summary">
                        {toolSummary(t.name, t.args)}
                      </span>
                      {t.result === undefined ? (
                        <span className="tool-pending">
                          <span className="gen-dot" />
                          <span className="gen-dot" />
                          <span className="gen-dot" />
                        </span>
                      ) : null}
                    </div>
                    {t.result !== undefined ? (
                      <details className="tool-result">
                        <summary>结果</summary>
                        <pre>{t.result}</pre>
                      </details>
                    ) : null}
                  </div>
                ))}
                <div className="content">{m.content}</div>
              </div>
            ))}
            {streaming ? (
              <div className="generating">
                <span className="gen-dots">
                  <span className="gen-dot" />
                  <span className="gen-dot" />
                  <span className="gen-dot" />
                </span>
                生成中
              </div>
            ) : null}
            {changes.length > 0 && (
              <div className="changes">
                <div className="changes-title">
                  本轮改动 ({changes.length})
                  <button
                    type="button"
                    className="changes-undo"
                    onClick={() => void undoLastRun()}
                  >
                    撤销本轮
                  </button>
                </div>
                <ul className="changes-list">
                  {changes.map((c, i) => (
                    <li key={`${c.kind}-${c.path}-${i}`}>
                      <button
                        className={`changes-row ${
                          activeDiff?.path === c.path &&
                          activeDiff?.kind === c.kind
                            ? 'active'
                            : ''
                        }`}
                        onClick={() => setActiveDiff(c)}
                        title={c.path}
                      >
                        <span className={`badge badge-${c.kind}`}>
                          {changeLabel(c.kind)}
                        </span>
                        <span className="changes-path">{c.path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="composer-wrap">
            {runState === 'paused' && checkpoint ? (
              <div className="resume-banner">
                <span className="resume-text">
                  任务已暂停：{checkpoint.query.slice(0, 60)}
                </span>
                <button type="button" onClick={() => void resumeRun()}>
                  继续
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void cancelRun()}
                >
                  放弃
                </button>
              </div>
            ) : null}
            {mention ? (
              <MentionPicker
                results={mentionResults}
                active={mentionActive}
                onSelect={selectMention}
                onHover={setMentionActive}
              />
            ) : null}
            <div className="composer">
              {mentions.length > 0 ? (
                <div className="mention-chips">
                  {mentions.map((path) => (
                    <span key={path} className="mention-chip">
                      <span>@{path}</span>
                      <button
                        type="button"
                        title="移除引用"
                        onClick={() => removeMention(path)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <textarea
                ref={inputRef}
                className="composer-input"
                value={input}
                placeholder="Chat with AI Editor"
                onChange={handleInputChange}
                onKeyDown={(e) => {
                  if (mention && mentionResults.length) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setMentionActive((i) =>
                        Math.min(mentionResults.length - 1, i + 1),
                      );
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setMentionActive((i) => Math.max(0, i - 1));
                      return;
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      selectMention(mentionResults[mentionActive]);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setMention(null);
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-toolbar">
                <div className="composer-left">
                  <button
                    type="button"
                    className="icon-btn"
                    title="引用文件 (@)"
                    onClick={insertAt}
                  >
                    +
                  </button>
                  <span className="chip">
                    <span className="chip-dot" />
                    {mode === 'local' ? '本地 Agent' : '云端 Agent'}
                  </span>
                  <ModelSelect
                    value={currentModel}
                    groups={modelGroups}
                    disabled={!config || modelOptions.length === 0}
                    onChange={(id) => void updateModel(id)}
                    title="切换模型"
                  />
                </div>
                <div className="composer-right">
                  {streaming ? (
                    <>
                      <button
                        className="send-btn"
                        title="暂停"
                        onClick={() => void pauseRun()}
                      >
                        ⏸
                      </button>
                      <button
                        className="send-btn stop"
                        title="停止"
                        onClick={stop}
                      >
                        ■
                      </button>
                    </>
                  ) : (
                    <button
                      className="send-btn"
                      title="发送 (Enter)"
                      onClick={() => void send()}
                      disabled={!input.trim()}
                    >
                      ↑
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="composer-status">
              <span className="status-brand">AI Editor</span>
              <span className="status-sep">·</span>
              <span>{mode === 'local' ? '本地' : '云端'}</span>
              <span className="status-sep">·</span>
              <span>
                {roots.length ? `${roots.length} 个文件夹` : '未选择工作区'}
              </span>
              {streaming ? (
                <>
                  <span className="status-sep">·</span>
                  <span className="status-timer">
                    ⏱ {formatElapsed(elapsedMs)}
                  </span>
                </>
              ) : null}
              <span className="status-spacer" />
              <span className="muted composer-hint">
                Enter 发送 · Shift+Enter 换行 · @ 引用文件
              </span>
            </div>
          </div>
        </section>
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
