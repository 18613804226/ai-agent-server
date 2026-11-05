import { useEffect, useRef, useState } from 'react';

interface Line {
  type: 'cmd' | 'out';
  text: string;
}

interface TerminalTab {
  id: string;
  name: string;
  profile: string;
  lines: Line[];
  cwd: string;
  input: string;
  running: boolean;
}

const TERMINAL_PROFILES = [
  { id: 'powershell', name: 'PowerShell' },
  { id: 'cmd', name: 'Command Prompt' },
  { id: 'gitbash', name: 'Git Bash' },
];

/** 剥离 ANSI 转义码（颜色/光标等），避免终端显示乱码 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/** 把输出行里的 URL 渲染成可点击链接 */
function renderLine(text: string, onOpenBrowser?: (url: string) => void) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) => {
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={i}
          href={part}
          className="terminal-link"
          onClick={(e) => {
            e.preventDefault();
            // Ctrl/Cmd + 点击 → 外部浏览器
            if (e.ctrlKey || e.metaKey) {
              window.open(part, '_blank', 'noopener,noreferrer');
              return;
            }
            if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(part)) {
              onOpenBrowser?.(part);
            } else {
              window.open(part, '_blank', 'noopener,noreferrer');
            }
          }}
        >
          {part}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

/** 终端：多标签 + 实时输出 + 历史命令（↑/↓）+ 可点击链接 */
export function Terminal({
  onClose,
  height,
  onOpenBrowser,
}: {
  onClose: () => void;
  height?: number;
  onOpenBrowser?: (url: string) => void;
}) {
  const [terminals, setTerminals] = useState<TerminalTab[]>([
    {
      id: 'default',
      name: 'PowerShell',
      profile: 'powershell',
      lines: [
        { type: 'out', text: '本地终端：命令在工作区目录执行，支持 cd / clear。' },
      ],
      cwd: '',
      input: '',
      running: false,
    },
  ]);
  const [activeId, setActiveId] = useState('default');
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const bodyRef = useRef<HTMLDivElement>(null);

  const active = terminals.find((t) => t.id === activeId) ?? terminals[0];

  useEffect(() => {
    if (!active.cwd) {
      void window.electron.terminal
        .cwd()
        .then((c) =>
          setTerminals((prev) =>
            prev.map((t) => (t.id === activeId ? { ...t, cwd: c } : t)),
          ),
        )
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // 实时输出（spawn 长进程）
  useEffect(() => {
    const off = window.electron.terminal.onOutput((ev) => {
      if (ev.type === 'data' && ev.data) {
        const text = stripAnsi(ev.data);
        setTerminals((prev) =>
          prev.map((t) => {
            if (t.id !== activeId) return t;
            const lines = [...t.lines];
            const parts = text.split('\n');
            const last = lines[lines.length - 1];
            if (last && last.type === 'out') {
              lines[lines.length - 1] = { ...last, text: last.text + parts[0] };
            } else {
              lines.push({ type: 'out', text: parts[0] });
            }
            for (let i = 1; i < parts.length; i++) {
              lines.push({ type: 'out', text: parts[i] });
            }
            return { ...t, lines };
          }),
        );
      } else if (ev.type === 'clear') {
        setTerminals((prev) =>
          prev.map((t) => (t.id === activeId ? { ...t, lines: [] } : t)),
        );
      } else if (ev.type === 'cwd' && ev.cwd) {
        setTerminals((prev) =>
          prev.map((t) => (t.id === activeId ? { ...t, cwd: ev.cwd! } : t)),
        );
      } else if (ev.type === 'exit') {
        setTerminals((prev) =>
          prev.map((t) => (t.id === activeId ? { ...t, running: false } : t)),
        );
      }
    });
    return off;
  }, [activeId]);

  // 输出自动贴底；用户向上查看时不打断
  const stickToBottomRef = useRef(true);
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    if (stickToBottomRef.current) {
      bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
    }
  }, [active.lines]);

  const updateTerminal = (
    id: string,
    patch: Partial<TerminalTab> | ((prev: TerminalTab) => Partial<TerminalTab>),
  ) => {
    setTerminals((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const p = typeof patch === 'function' ? patch(t) : patch;
        return { ...t, ...p };
      }),
    );
  };

  const addTerminal = (profile: string) => {
    const p = TERMINAL_PROFILES.find((x) => x.id === profile);
    const id = crypto.randomUUID();
    setTerminals((prev) => [
      ...prev,
      {
        id,
        name: p?.name ?? '终端',
        profile,
        lines: [],
        cwd: active.cwd,
        input: '',
        running: false,
      },
    ]);
    setActiveId(id);
  };

  const closeTerminal = (id: string) => {
    setTerminals((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) setActiveId(next[0].id);
      return next;
    });
  };

  const run = async (command: string) => {
    const id = active.id;
    const cmd = command.trim();
    if (!cmd || active.running) return;
    const prompt = `PS ${active.cwd || ''}>`;
    // 记录历史（去重相邻重复）
    setHistory((prev) =>
      prev[prev.length - 1] === cmd ? prev : [...prev, cmd],
    );
    setHistoryIndex(-1);
    updateTerminal(id, (prev) => ({
      lines: [...prev.lines, { type: 'cmd', text: `${prompt} ${cmd}` }],
      input: '',
      running: true,
    }));
    try {
      await window.electron.terminal.spawn(
        cmd,
        active.cwd || undefined,
        active.profile,
      );
    } catch (e: any) {
      updateTerminal(id, (prev) => ({
        lines: [...prev.lines, { type: 'out', text: `⚠️ ${e?.message || e}` }],
        running: false,
      }));
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Ctrl+C 停止当前进程
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      void window.electron.terminal.kill();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!history.length) return;
      const idx =
        historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(idx);
      updateTerminal(active.id, { input: history[idx] });
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex < 0) return;
      const idx = historyIndex + 1;
      if (idx >= history.length) {
        setHistoryIndex(-1);
        updateTerminal(active.id, { input: '' });
      } else {
        setHistoryIndex(idx);
        updateTerminal(active.id, { input: history[idx] });
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void run(active.input);
    }
  };

  return (
    <div
      className="terminal"
      style={height ? { height, flex: 'none' } : undefined}
    >
      <div className="terminal-header">
        <div className="terminal-tabs">
          {terminals.map((t) => (
            <div
              key={t.id}
              className={`terminal-tab${t.id === active.id ? ' active' : ''}`}
            >
              <button
                type="button"
                className="terminal-tab-label"
                title={t.cwd}
                onClick={() => setActiveId(t.id)}
              >
                {t.name}
              </button>
              <button
                type="button"
                className="terminal-tab-close"
                title="关闭终端"
                onClick={() => closeTerminal(t.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-add-wrap">
          <button
            type="button"
            className="terminal-tab-add"
            title="清屏"
            onClick={() => updateTerminal(active.id, { lines: [] })}
          >
            ⌫
          </button>
          <button
            type="button"
            className="terminal-tab-add"
            title="新建终端"
            onClick={() => setShowProfileMenu((v) => !v)}
          >
            +
          </button>
          {showProfileMenu ? (
            <div className="terminal-profile-menu">
              {TERMINAL_PROFILES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    addTerminal(p.id);
                    setShowProfileMenu(false);
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="terminal-close"
          onClick={onClose}
          title="关闭终端"
          aria-label="关闭终端"
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m4 4 8 8m0-8-8 8" />
          </svg>
        </button>
      </div>
      <div className="term-prompt">
        <span className="term-ps">{`PS ${active.cwd || ''}>`}</span>
        <input
          aria-label="终端命令"
          value={active.input}
          onChange={(e) => updateTerminal(active.id, { input: e.target.value })}
          onKeyDown={onInputKeyDown}
          autoFocus
          spellCheck={false}
        />
        {active.running ? (
          <>
            <span className="terminal-running">服务运行中</span>
            <button
              type="button"
              className="terminal-stop"
              title="停止"
              onClick={() => void window.electron.terminal.kill()}
            >
              ■
            </button>
          </>
        ) : null}
      </div>
      <div className="terminal-body" ref={bodyRef} onScroll={onScroll}>
        {active.lines.map((line, i) => (
          <div key={i} className={`term-line ${line.type}`}>
            {renderLine(line.text, onOpenBrowser)}
          </div>
        ))}
      </div>
    </div>
  );
}
