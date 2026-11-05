import { memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { changeLabel } from '../diff';
import type { FileChange } from '../mode/types';
import { ImageLightbox } from './ImageLightbox';

/** 一个聊天任务（会话） */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMsg[];
  input: string;
  images: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 用户本轮附带的图片（仅当前轮展示，不带入历史） */
  images?: string[];
  thought?: string;
  /** 按到达顺序排列的事件流（content / tool_call / tool_result 交错）；历史消息没有 */
  events?: ChatEventItem[];
  /** 本轮消耗的总 token 数（含输入） */
  tokens?: number;
  /** 本轮生成的 token 数（completion），用于计算真实生成速度 */
  completionTokens?: number;
  /** 本轮耗时（毫秒） */
  durationMs?: number;
  /** 本轮修改的文件（用于消息末尾预览/对比） */
  changes?: FileChange[];
}

export type ChatEventItem =
  | { type: 'thought'; content: string }
  | { type: 'content'; content: string }
  | {
      type: 'tool_call';
      name: string;
      args: Record<string, unknown>;
      index: number;
      result?: string;
    };

/** 渲染块：由事件流还原出的「段落 / 思考 / 工具」序列 */
type MessageBlock =
  | { type: 'thought'; text: string }
  | { type: 'content'; text: string }
  | { type: 'images'; urls: string[] }
  | {
      type: 'tool';
      index: number;
      name: string;
      args: Record<string, unknown>;
      result?: string;
    };

/** 生成耗时格式化：<60s 显示 X.Xs，否则显示 m:ss */
export function formatElapsed(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remainder = Math.floor(sec % 60);
  return `${min}:${remainder.toString().padStart(2, '0')}`;
}

/** 折叠多余空行：模型或标签清洗后常在段落间留下 3+ 个换行，统一成最多一个空行 */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * 把事件流按到达顺序还原成渲染块：相邻 content / thought 合并，工具块保持原位。
 * 没有 events 的历史消息（断点续跑）退回 thought + content 两段。
 */
function buildMessageBlocks(msg: ChatMsg): MessageBlock[] {
  let blocks: MessageBlock[];
  if (msg.events?.length) {
    blocks = [];
    for (const ev of msg.events) {
      if (ev.type === 'content') {
        const last = blocks[blocks.length - 1];
        if (last?.type === 'content') last.text += ev.content;
        else blocks.push({ type: 'content', text: ev.content });
      } else if (ev.type === 'thought') {
        const last = blocks[blocks.length - 1];
        if (last?.type === 'thought') last.text += ev.content;
        else blocks.push({ type: 'thought', text: ev.content });
      } else if (ev.type === 'tool_call') {
        blocks.push({
          type: 'tool',
          index: ev.index,
          name: ev.name,
          args: ev.args,
          result: ev.result,
        });
      }
    }
  } else {
    blocks = [];
    if (msg.thought) blocks.push({ type: 'thought', text: msg.thought });
    if (msg.content) blocks.push({ type: 'content', text: msg.content });
  }
  // 用户本轮附带的图片显示在文本之后
  if (msg.images?.length) blocks.push({ type: 'images', urls: msg.images });
  return blocks;
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

/** 工具操作块：整条头部可点击展开/收起，箭头只是状态指示（默认折叠） */
function ToolActivityBlock({
  block,
}: {
  block: Extract<MessageBlock, { type: 'tool' }>;
}) {
  const [open, setOpen] = useState(false);
  const expandable = block.result !== undefined;
  const toggle = () => setOpen((v) => !v);
  return (
    <div className="tool-activity">
      <div
        className={`tool-activity-head${expandable ? ' clickable' : ''}`}
        onClick={expandable ? toggle : undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-label={expandable ? (open ? '收起结果' : '展开结果') : undefined}
        title={expandable ? (open ? '收起结果' : '展开结果') : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle();
                }
              }
            : undefined
        }
      >
        <span className="tool-icon">{toolIcon(block.name)}</span>
        <span className="tool-summary">
          {toolSummary(block.name, block.args)}
        </span>
        {expandable ? (
          <span className={`tool-toggle${open ? ' open' : ''}`}>
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="m6 4 4 4-4 4" />
            </svg>
          </span>
        ) : (
          <span className="tool-pending">
            <span className="gen-dot" />
            <span className="gen-dot" />
            <span className="gen-dot" />
          </span>
        )}
      </div>
      {expandable && open ? (
        <div className="tool-result">
          <pre>{block.result}</pre>
        </div>
      ) : null}
    </div>
  );
}

/** 单条消息：按事件流顺序渲染段落 / 思考 / 工具 / 图片（memo 避免流式刷新时整列表重渲染） */
export const ChatMessage = memo(function ChatMessage({
  msg,
  streaming,
  onOpenBrowser,
  onSelectDiff,
  onApplyDiff,
  onSaveChanges,
}: {
  msg: ChatMsg;
  streaming: boolean;
  onOpenBrowser?: (url: string) => void;
  onSelectDiff?: (c: FileChange) => void;
  onApplyDiff?: (path: string, content: string) => void;
  onSaveChanges?: () => void;
}) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const blocks = useMemo(() => buildMessageBlocks(msg), [msg]);
  const pendingChanges = useMemo(
    () => msg.changes?.filter((c) => c.pending) ?? [],
    [msg.changes],
  );
  return (
    <div className={`msg msg-${msg.role}`}>
      {blocks.map((block, i) => {
        if (block.type === 'content') {
          const text = collapseBlankLines(block.text);
          return text ? (
            <div key={i} className="content markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => {
                        // 本机地址：点击用内置浏览器打开，避免把主窗口导航走
                        if (
                          href &&
                          onOpenBrowser &&
                          /^https?:\/\/(localhost|127\.0\.0\.1)/.test(href)
                        ) {
                          e.preventDefault();
                          onOpenBrowser(href);
                        }
                      }}
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {text}
              </ReactMarkdown>
            </div>
          ) : null;
        }
        if (block.type === 'thought') {
          const text = collapseBlankLines(block.text);
          return text ? (
            <pre key={i} className="thought">
              {text}
            </pre>
          ) : null;
        }
        if (block.type === 'images') {
          return (
            <div key={i} className="message-images">
              {block.urls.map((url, j) => (
                <img
                  key={j}
                  src={url}
                  alt={`图片 ${j + 1}`}
                  className="message-image"
                  style={{ cursor: 'zoom-in' }}
                  onClick={() => setPreviewIndex(j)}
                />
              ))}
            </div>
          );
        }
        return <ToolActivityBlock key={i} block={block} />;
      })}
      {msg.role === 'assistant' && msg.tokens != null && !streaming ? (
        <div className="msg-meta msg-meta-bottom">
          {msg.tokens} tokens
          {msg.completionTokens != null
            ? ` · 生成 ${msg.completionTokens}`
            : ''}
          {msg.durationMs != null && msg.durationMs > 0
            ? ` · 耗时 ${formatElapsed(msg.durationMs)}`
            : ''}
          {msg.durationMs && msg.durationMs > 0
            ? ` · ${(
                ((msg.completionTokens ?? msg.tokens) ?? 0) /
                (msg.durationMs / 1000)
              ).toFixed(0)} tokens/s`
            : ''}
        </div>
      ) : null}
      {msg.changes?.length ? (
        <div className="message-changes">
          <div className="message-changes-title">
            {pendingChanges.length
              ? `${pendingChanges.length} 个文件待确认`
              : `${msg.changes.length} 个文件已修改`}
            {pendingChanges.length ? (
              <>
                <button
                  type="button"
                  className="message-changes-save"
                  onClick={() =>
                    pendingChanges.forEach((c) =>
                      onApplyDiff?.(c.path, c.after ?? ''),
                    )
                  }
                  title="确认写入文件"
                >
                  确认写入
                </button>
                <button
                  type="button"
                  className="message-changes-revert"
                  onClick={() =>
                    pendingChanges.forEach((c) =>
                      onApplyDiff?.(c.path, c.before ?? ''),
                    )
                  }
                  title="取消改动，恢复为修改前"
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="message-changes-save"
                  onClick={() => onSaveChanges?.()}
                  title="保存全部改动（写入文件）"
                >
                  保存改动
                </button>
                <button
                  type="button"
                  className="message-changes-revert"
                  onClick={() =>
                    msg.changes?.forEach((c) =>
                      onApplyDiff?.(c.path, c.before ?? ''),
                    )
                  }
                  title="放弃全部改动，恢复为修改前"
                >
                  全部回滚
                </button>
              </>
            )}
          </div>
          <ul className="message-changes-list">
            {msg.changes.map((c, i) => (
              <li key={`${c.kind}-${c.path}-${i}`}>
                <button
                  type="button"
                  onClick={() => onSelectDiff?.(c)}
                  title={`预览改动：${c.path}`}
                >
                  <span className={`badge badge-${c.kind}`}>
                    {changeLabel(c.kind)}
                  </span>
                  <span className="message-changes-path">{c.path}</span>
                  {c.pending ? (
                    <span className="message-changes-pending">待确认</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {previewIndex !== null && msg.images?.length ? (
        <ImageLightbox
          images={msg.images}
          index={previewIndex}
          onClose={() => setPreviewIndex(null)}
          onNavigate={setPreviewIndex}
        />
      ) : null}
    </div>
  );
});
