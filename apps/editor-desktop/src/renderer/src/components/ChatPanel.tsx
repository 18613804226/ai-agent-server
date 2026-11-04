import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { ChatMessage, formatElapsed, type ChatMsg } from './ChatMessage';
import { Composer } from './Composer';
import { changeLabel, diffLines } from '../diff';
import type { RunCheckpointInfo } from '../electron';
import type {
  AgentMode,
  AppConfig,
  FileChange,
} from '../mode/types';
import type { ChatSession } from './ChatMessage';

/**
 * 右侧聊天区：标题、消息流、改动列表、输入区、状态栏。
 * 只负责展示与转发，状态和 agent 逻辑由父组件提供。
 */
export function ChatPanel({
  mode,
  sessionId,
  sessions,
  activeId,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  messages,
  streaming,
  elapsedMs,
  changes,
  activeDiff,
  runState,
  checkpoint,
  input,
  setInput,
  images,
  setImages,
  mentionFiles,
  config,
  currentModel,
  modelGroups,
  modelOptions,
  rootsCount,
  chatRef,
  inputRef,
  onSend,
  onStop,
  onPause,
  onResume,
  onCancel,
  onUndo,
  onSelectDiff,
  onModelChange,
  onToggleApproval,
  onOpenBrowser,
}: {
  mode: AgentMode;
  sessionId: string;
  onOpenBrowser?: (url: string) => void;
  sessions: ChatSession[];
  activeId: string;
  onCreateSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  messages: ChatMsg[];
  streaming: boolean;
  elapsedMs: number;
  changes: FileChange[];
  activeDiff: FileChange | null;
  runState: string;
  checkpoint: RunCheckpointInfo | null;
  input: string;
  setInput: (v: string | ((prev: string) => string)) => void;
  images: string[];
  setImages: (v: string[] | ((prev: string[]) => string[])) => void;
  mentionFiles: string[];
  config: AppConfig | null;
  currentModel: string;
  modelGroups: { provider: string; models: { id: string; label: string }[] }[];
  modelOptions: { id: string; label: string }[];
  rootsCount: number;
  chatRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSend: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onUndo: () => void;
  onSelectDiff: (c: FileChange) => void;
  onModelChange: (id: string) => void;
  onToggleApproval: () => void;
}) {
  const stickToBottomRef = useRef(true);

  /** 用户手动滚动后，离开底部就中断自动贴底 */
  const onScroll = () => {
    const el = chatRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    if (stickToBottomRef.current) {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
    }
  }, [messages, changes, chatRef]);

  // 切换会话时回到底部
  useEffect(() => {
    stickToBottomRef.current = true;
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [sessionId]);

  const changeStats = useMemo(
    () =>
      changes.map((c) => {
        const diffs = diffLines(c.before ?? '', c.after ?? '');
        return {
          added: diffs.filter((d) => d.type === 'add').length,
          deleted: diffs.filter((d) => d.type === 'del').length,
        };
      }),
    [changes],
  );
  const totalAdded = changeStats.reduce((sum, s) => sum + s.added, 0);
  const totalDeleted = changeStats.reduce((sum, s) => sum + s.deleted, 0);

  return (
    <section className="chat">
      <div className="chat-header">
        AI 助手 · editor agent · {mode === 'local' ? '本地' : '云端'}
      </div>
      <div className="session-tabs">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-tab${s.id === activeId ? ' active' : ''}`}
          >
            <button
              type="button"
              className="session-tab-label"
              title={s.title}
              onClick={() => onSelectSession(s.id)}
            >
              {s.title}
            </button>
            <button
              type="button"
              className="session-tab-close"
              title="删除任务"
              onClick={() => onDeleteSession(s.id)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="session-tab-new"
          title="新建任务"
          onClick={onCreateSession}
        >
          +
        </button>
      </div>
      <div className="chat-body" ref={chatRef} onScroll={onScroll}>
        {messages.length === 0 && (
          <div className="muted chat-hint">
            试试：帮我看下工作区里有哪些文件 / 读一下 xxx 文件
          </div>
        )}
        {messages.map((m) => (
          <ChatMessage
            key={m.id}
            msg={m}
            streaming={streaming}
            onOpenBrowser={onOpenBrowser}
          />
        ))}
        {streaming ? (
          <div className="generating">
            <span className="gen-dots">
              <span className="gen-dot" />
              <span className="gen-dot" />
              <span className="gen-dot" />
            </span>
            生成中
            <span className="generating-timer">
              ⏱ {formatElapsed(elapsedMs)}
            </span>
          </div>
        ) : null}
        {changes.length > 0 && (
          <div className="changes">
            <div className="changes-title">
              {changes.length} files changed +{totalAdded} -{totalDeleted}
              <button
                type="button"
                className="changes-undo"
                onClick={onUndo}
              >
                撤销本轮
              </button>
            </div>
            <ul className="changes-list">
              {changes.map((c, i) => (
                <li key={`${c.kind}-${c.path}-${i}`}>
                  <button
                    className={`changes-row ${
                      activeDiff?.path === c.path && activeDiff?.kind === c.kind
                        ? 'active'
                        : ''
                    }`}
                    onClick={() => onSelectDiff(c)}
                    title={c.path}
                  >
                    <span className={`badge badge-${c.kind}`}>
                      {changeLabel(c.kind)}
                    </span>
                    <span className="changes-path">{c.path}</span>
                    <span className="changes-stats">
                      <span className="changes-added">
                        +{changeStats[i]?.added ?? 0}
                      </span>
                      <span className="changes-deleted">
                        -{changeStats[i]?.deleted ?? 0}
                      </span>
                    </span>
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
            <button type="button" onClick={onResume}>
              继续
            </button>
            <button type="button" className="ghost" onClick={onCancel}>
              放弃
            </button>
          </div>
        ) : null}
        <Composer
          input={input}
          setInput={setInput}
          images={images}
          setImages={setImages}
          streaming={streaming}
          onSend={onSend}
          onStop={onStop}
          onPause={onPause}
          mentionFiles={mentionFiles}
          config={config}
          mode={mode}
          currentModel={currentModel}
          modelGroups={modelGroups}
          modelOptions={modelOptions}
          onModelChange={onModelChange}
          onToggleApproval={onToggleApproval}
          inputRef={inputRef}
        />
        <div className="composer-status">
          <div className="composer-status-meta">
            <span className="status-brand">AI Editor</span>
            <span className="status-sep">·</span>
            <span>{mode === 'local' ? '本地' : '云端'}</span>
            <span className="status-sep">·</span>
            <span>
              {rootsCount ? `${rootsCount} 个文件夹` : '未选择工作区'}
            </span>
          </div>
          <span
            className="muted composer-hint"
            title="Enter 发送 · Shift+Enter 换行 · @ 引用文件"
          >
            Enter 发送 · Shift+Enter 换行 · @ 引用文件
          </span>
        </div>
      </div>
    </section>
  );
}
