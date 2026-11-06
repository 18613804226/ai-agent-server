import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
} from 'react';
import { ImageLightbox } from './ImageLightbox';
import { MentionPicker } from './MentionPicker';
import { ModelSelect } from './ModelSelect';
import type { AgentMode, AppConfig } from '../mode/types';
import { extractMentions } from '../files';

/** 把图片文件读成 base64 data URL（用于多模态输入） */
function readImageFiles(files: FileList | File[]): Promise<string[]> {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
  return Promise.all(
    list.map(
      (file) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        }),
    ),
  );
}

/**
 * 输入区：文本 + 图片（选择/粘贴/拖拽）+ @ 引用 + 模型选择 + 审批开关。
 * 输入内容与图片由父组件持有（发送逻辑在父组件）。
 */
export function Composer({
  input,
  setInput,
  images,
  setImages,
  streaming,
  onSend,
  onStop,
  onPause,
  mentionFiles,
  config,
  mode,
  currentModel,
  modelGroups,
  modelOptions,
  onModelChange,
  onToggleApproval,
  inputRef,
}: {
  input: string;
  setInput: (v: string | ((prev: string) => string)) => void;
  images: string[];
  setImages: (v: string[] | ((prev: string[]) => string[])) => void;
  streaming: boolean;
  onSend: () => void;
  onStop: () => void;
  onPause: () => void;
  mentionFiles: string[];
  config: AppConfig | null;
  mode: AgentMode;
  currentModel: string;
  modelGroups: { provider: string; models: { id: string; label: string }[] }[];
  modelOptions: { id: string; label: string }[];
  onModelChange: (id: string) => void;
  onToggleApproval: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [mention, setMention] = useState<{
    query: string;
    start: number;
  } | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  return (
    <>
      {mention ? (
        <MentionPicker
          results={mentionResults}
          active={mentionActive}
          onSelect={selectMention}
          onHover={setMentionActive}
        />
      ) : null}
      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={async (e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) {
            const urls = await readImageFiles(e.dataTransfer.files);
            setImages((prev) => [...prev, ...urls]);
          }
        }}
      >
        {images.length > 0 ? (
          <div className="image-preview-row">
            {images.map((url, i) => (
              <div key={i} className="image-preview">
                <img
                  src={url}
                  alt={`图片 ${i + 1}`}
                  style={{ cursor: 'zoom-in' }}
                  onClick={() => setPreviewIndex(i)}
                />
                <button
                  type="button"
                  className="image-preview-remove"
                  title="移除图片"
                  onClick={() =>
                    setImages((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
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
          onBlur={() => {
            // 失焦时关闭 @ 文件选择（延迟，避免点击选项时提前关闭）
            setTimeout(() => setMention(null), 150);
          }}
          onPaste={async (e) => {
            const files = e.clipboardData?.files;
            if (files && files.length) {
              e.preventDefault();
              const urls = await readImageFiles(files);
              setImages((prev) => [...prev, ...urls]);
            }
          }}
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
              void onSend();
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
            <button
              type="button"
              className="icon-btn"
              title="添加图片"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                <circle cx="5.5" cy="6" r="1" />
                <path d="m3 12 3.5-3.5 2.5 2.5 2-2L14.5 12" />
              </svg>
            </button>
            <span className="chip agent-chip">
              <span className="chip-dot" />
              <span className="agent-chip-label">
                {mode === 'local' ? '本地 Agent' : '云端 Agent'}
              </span>
            </span>
            <ModelSelect
              value={currentModel}
              groups={modelGroups}
              disabled={!config || modelOptions.length === 0}
              onChange={onModelChange}
              title="切换模型"
            />
            <button
              type="button"
              className={`icon-btn approval-toggle ${
                config?.commandApproval === 'auto' ? 'is-auto' : 'is-ask'
              }`}
              title={
                config?.commandApproval === 'auto'
                  ? '当前：命令自动放行（点击切换为询问）'
                  : '当前：危险命令需确认（点击切换为自动放行）'
              }
              aria-label={
                config?.commandApproval === 'auto'
                  ? '命令自动放行，点击切换为询问'
                  : '命令询问，点击切换为自动放行'
              }
              aria-pressed={config?.commandApproval === 'auto'}
              onClick={onToggleApproval}
            >
              <svg
                className="approval-icon"
                viewBox="0 0 20 20"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10 2.5 16 5v4.7c0 3.5-2.4 6.1-6 7.8-3.6-1.7-6-4.3-6-7.8V5l6-2.5Z" />
                {config?.commandApproval === 'auto' ? (
                  <path d="m7.2 9.8 1.8 1.8 3.8-4" />
                ) : (
                  <>
                    <path d="M8.2 7.6a1.9 1.9 0 1 1 3.3 1.3c-.9.9-1.5 1.1-1.5 2.2" />
                    <path d="M10 13.7h.01" />
                  </>
                )}
              </svg>
            </button>
          </div>
          <div className="composer-right">
            {streaming ? (
              <>
                <button
                  className="send-btn"
                  title="暂停"
                  onClick={onPause}
                >
                  ⏸
                </button>
                <button className="send-btn stop" title="停止" onClick={onStop}>
                  ■
                </button>
              </>
            ) : (
              <button
                className="send-btn"
                title="发送 (Enter)"
                onClick={onSend}
                disabled={!input.trim() && images.length === 0}
              >
                ↑
              </button>
            )}
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={async (e) => {
            const files = e.target.files;
            if (files?.length) {
              const urls = await readImageFiles(files);
              setImages((prev) => [...prev, ...urls]);
            }
            e.target.value = '';
          }}
        />
      </div>
      {previewIndex !== null && images.length ? (
        <ImageLightbox
          images={images}
          index={previewIndex}
          onClose={() => setPreviewIndex(null)}
          onNavigate={setPreviewIndex}
        />
      ) : null}
    </>
  );
}
