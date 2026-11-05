import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { CodeEditorHandle } from '../components/CodeEditor';
import type { ChatEvent, ChatHistoryItem, AgentPromptContext, AgentMode, AgentTransport, WorkspaceProvider, FileChange, ApprovalPreview } from '../mode/types';
import type { ChatMsg } from '../components/ChatMessage';

/** 当前会话的可变状态（由外部会话管理注入） */
export interface ChatSessionState {
  messages: ChatMsg[];
  input: string;
  images: string[];
  title?: string;
}
import type { RunCheckpointInfo } from '../electron';
import { extractMentions } from '../files';
import { normalizePath } from '../path';

export interface EditorTab {
  path: string;
  content: string;
  savedContent: string;
}

export interface AgentBackend {
  transport: AgentTransport;
  workspace: WorkspaceProvider;
}

interface PendingApproval {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  preview?: ApprovalPreview[];
}

interface UseAgentRunDeps {
  backend: AgentBackend;
  mode: AgentMode;
  session: ChatSessionState;
  updateSession: (
    patch:
      | Partial<ChatSessionState>
      | ((prev: ChatSessionState) => Partial<ChatSessionState>),
  ) => void;
  activeFile: string;
  fileContent: string;
  editorRef: RefObject<CodeEditorHandle | null>;
  activeFileRef: RefObject<string>;
  editorTabsRef: RefObject<EditorTab[]>;
  setActiveFile: (v: string) => void;
  setFileContentState: (v: string) => void;
  setSavedContentState: (v: string) => void;
  setEditorTabs: (
    v: EditorTab[] | ((prev: EditorTab[]) => EditorTab[]),
  ) => void;
  setStreamingEditPath: (v: string | null) => void;
  setFileContent: (v: string) => void;
  setSavedContent: (v: string) => void;
  setActiveDiff: (v: FileChange | null) => void;
  setError: (v: string) => void;
  /** 工作区重载；用 ref 传入避免与 useWorkspace 循环依赖 */
  reloadRef: RefObject<() => Promise<void>>;
  /** 内置浏览器打开回调（open_in_browser 工具） */
  onBrowserOpen: (url: string) => void;
}

/**
 * Agent 运行逻辑：消息列表、流式事件、发送/暂停/继续/停止/撤销。
 * 编辑器相关的 refs / setState 由宿主注入。
 */
export function useAgentRun(deps: UseAgentRunDeps) {
  const {
    backend,
    mode,
    session,
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
    onBrowserOpen,
  } = deps;

  const messages = session.messages;
  const [streaming, setStreaming] = useState(false);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(
    null,
  );
  const [runState, setRunState] = useState<string>('idle');
  const [checkpoint, setCheckpoint] = useState<RunCheckpointInfo | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const genStartRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  /** 把 agent 事件应用到消息列表；本地/云端/断点续跑共用 */
  const applyAgentEvent = useCallback(
    (ev: ChatEvent, assistantId: string) => {
      if (ev.type === 'browser_open') {
        if (ev.url) onBrowserOpen(ev.url);
        return;
      }
      if (ev.type === 'approval_request') {
        setPendingApproval({
          id: ev.id ?? '',
          toolName: ev.toolName ?? '',
          args: ev.args ?? {},
          preview: ev.preview,
        });
        return;
      }
      if (ev.type === 'done' && ev.changes) {
        setChanges(ev.changes);
      }
      if (ev.type === 'done') {
        const dur = Date.now() - genStartRef.current;
        updateSession((prev) => ({
          messages: prev.messages.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  tokens: ev.tokens,
                  completionTokens: ev.completionTokens,
                  durationMs: dur,
                  changes: ev.changes,
                }
              : msg,
          ),
        }));
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
                const cachedTab = editorTabsRef.current.find(
                  (tab) => tab.path === editPath,
                );
                const content =
                  cachedTab?.content ??
                  (await backend.workspace.readFile(editPath));
                const saved = cachedTab?.savedContent ?? content;
                setFileContentState(content);
                setSavedContentState(saved);
                setEditorTabs((tabs) => {
                  const existing = tabs.find((tab) => tab.path === editPath);
                  return existing
                    ? tabs.map((tab) =>
                        tab.path === editPath
                          ? { ...tab, content, savedContent: saved }
                          : tab,
                      )
                    : [
                        ...tabs,
                        { path: editPath, content, savedContent: saved },
                      ];
                });
              } catch {
                setFileContentState('');
                setSavedContentState('');
                setEditorTabs((tabs) =>
                  tabs.some((tab) => tab.path === editPath)
                    ? tabs
                    : [
                        ...tabs,
                        { path: editPath, content: '', savedContent: '' },
                      ],
                );
              }
              // 等 React 重渲染 + Monaco 编辑器重建完成
              await new Promise((r) => setTimeout(r, 250));
            }
            await editorRef.current?.applyStreamingEdit(edit);
            // 动画结束后同步内容到状态
            if (editPath) {
              const latest = editorRef.current?.getValue() ?? '';
              setFileContentState(latest);
              setEditorTabs((tabs) => {
                const existing = tabs.find((tab) => tab.path === editPath);
                return existing
                  ? tabs.map((tab) =>
                      tab.path === editPath ? { ...tab, content: latest } : tab,
                    )
                  : [
                      ...tabs,
                      { path: editPath, content: latest, savedContent: '' },
                    ];
              });
            }
          } finally {
            setStreamingEditPath(null);
          }
        })();
      }
      updateSession((prev) => ({
        messages: prev.messages.map((msg) => {
          if (msg.id !== assistantId) return msg;
          switch (ev.type) {
            case 'thought':
              return {
                ...msg,
                thought: (msg.thought ?? '') + (ev.content ?? ''),
                events: [
                  ...(msg.events ?? []),
                  { type: 'thought', content: ev.content ?? '' },
                ],
              };
            case 'content':
              return {
                ...msg,
                content: msg.content + (ev.content ?? ''),
                events: [
                  ...(msg.events ?? []),
                  { type: 'content', content: ev.content ?? '' },
                ],
              };
            case 'tool_call':
              return {
                ...msg,
                events: [
                  ...(msg.events ?? []),
                  {
                    type: 'tool_call',
                    name: ev.name ?? '',
                    args: ev.args ?? {},
                    index: ev.index ?? 0,
                  },
                ],
              };
            case 'tool_result':
              return {
                ...msg,
                events: (msg.events ?? []).map((e) =>
                  e.type === 'tool_call' && e.index === ev.index
                    ? { ...e, result: ev.result }
                    : e,
                ),
              };
            case 'error':
              return {
                ...msg,
                content: msg.content + `\n⚠️ ${ev.content ?? ''}`,
                // 错误文本也要进事件流，否则按 events 渲染时会丢
                events: [
                  ...(msg.events ?? []),
                  { type: 'content', content: `\n⚠️ ${ev.content ?? ''}` },
                ],
              };
            default:
              return msg;
          }
        }),
      }));
    },
    [
      activeFileRef,
      backend,
      editorRef,
      editorTabsRef,
      messages,
      updateSession,
      onBrowserOpen,
      setActiveFile,
      setFileContentState,
      setSavedContentState,
      setEditorTabs,
      setStreamingEditPath,
    ],
  );

  const send = useCallback(async (modelOverride?: string) => {
    const displayQuery = session.input.trim();
    if ((!displayQuery && !session.images.length) || streaming) return;

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
    const history: ChatHistoryItem[] = messages
      .filter((m) => m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    updateSession({ input: '', images: [] });
    setChanges([]);
    const assistantId = crypto.randomUUID();
    // 一次写入 user + assistant 两条消息，避免分两次更新相互覆盖；
    // 首个任务消息同时作为会话标题（默认「新任务」时替换为摘要）
    updateSession((prev) => ({
      title:
        prev.title === '新任务'
          ? displayQuery.replace(/\s+/g, ' ').trim().slice(0, 20) ||
            '新任务'
          : prev.title,
      messages: [
        ...prev.messages,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: displayQuery,
          images: session.images.length ? session.images : undefined,
          events: [],
        },
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          thought: '',
          events: [],
        },
      ],
    }));
    setStreaming(true);
    setRunState('running');
    abortRef.current = new AbortController();

    // 编辑器上下文：当前文件、内容、选区，随本轮一起发给 agent
    const selection = editorRef.current?.getSelection() ?? '';
    const agentContext: AgentPromptContext | undefined = activeFile
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
          model: mode === 'remote' ? modelOverride : undefined,
          history,
          context: agentContext,
          images: session.images,
        },
      );
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        updateSession((prev) => ({
          messages: [
            ...prev.messages,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: `⚠️ ${e?.message || e}`,
              events: [],
            },
          ],
        }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      void backend.transport.getRunState?.().then((info) => {
        setRunState(info.state);
        setCheckpoint(info.checkpoint);
      });
      void reloadRef.current();
    }
  }, [
    session.input,
    session.images,
    streaming,
    messages,
    backend,
    mode,
    editorRef,
    activeFile,
    fileContent,
    applyAgentEvent,
    updateSession,
    setChanges,
    setStreaming,
    setRunState,
    setError,
    reloadRef,
  ]);

  const stop = useCallback(() => {
    backend.transport.abort();
    abortRef.current?.abort();
  }, [backend]);

  const pauseRun = useCallback(async () => {
    const info = await backend.transport.pause();
    setRunState(info.state);
    setCheckpoint(info.checkpoint);
  }, [backend, setRunState, setCheckpoint]);

  const cancelRun = useCallback(async () => {
    const info = await backend.transport.cancel();
    setRunState(info.state);
    setCheckpoint(info.checkpoint);
  }, [backend, setRunState, setCheckpoint]);

  const resumeRun = useCallback(async () => {
    const info = await backend.transport.getRunState();
    const cp = info.checkpoint;
    if (!cp) return;
    updateSession({
      messages: cp.history.map((m) => ({ ...m, id: crypto.randomUUID() })),
    });
    setCheckpoint(cp);
    setRunState('running');
    setStreaming(true);
    const assistantId = crypto.randomUUID();
    updateSession((prev) => ({
      messages: [
        ...prev.messages,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          thought: '',
          events: [],
        },
      ],
    }));
    abortRef.current = new AbortController();
    try {
      await backend.transport.resume?.(
        (ev) => applyAgentEvent(ev, assistantId),
        abortRef.current.signal,
      );
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        updateSession((prev) => ({
          messages: [
            ...prev.messages,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: `⚠️ ${e?.message || e}`,
              events: [],
            },
          ],
        }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      const state = await backend.transport.getRunState?.();
      if (state) {
        setRunState(state.state);
        setCheckpoint(state.checkpoint);
      }
      void reloadRef.current();
    }
  }, [backend, applyAgentEvent, reloadRef, messages, updateSession]);

  const respondApproval = useCallback((approved: boolean) => {
    const request = pendingApproval;
    if (!request) return;
    setPendingApproval(null);
    void window.electron.agent.respondApproval(request.id, approved);
  }, [pendingApproval]);

  const undoLastRun = useCallback(async () => {
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
  }, [changes, activeFileRef, backend, setError, setChanges, setActiveDiff, setFileContent, setSavedContent]);

  return {
    messages,
    streaming,
    setStreaming,
    changes,
    setChanges,
    pendingApproval,
    setPendingApproval,
    runState,
    setRunState,
    checkpoint,
    setCheckpoint,
    elapsedMs,
    applyAgentEvent,
    send,
    stop,
    pauseRun,
    cancelRun,
    resumeRun,
    respondApproval,
    undoLastRun,
  };
}
