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

/** 终端：支持多标签（每个标签独立 cwd / 历史） */
export function Terminal({
  onClose,
  height,
}: {
  onClose: () => void;
  height?: number;
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
  const bodyRef = useRef<HTMLDivElement>(null);

  const active = terminals.find((t) => t.id === activeId) ?? terminals[0];

  // 新终端首次激活时拉取当前工作目录
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

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
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
      if (prev.length <= 1) return prev; // 至少保留一个
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
    updateTerminal(id, (prev) => ({
      lines: [...prev.lines, { type: 'cmd', text: `${prompt} ${cmd}` }],
      input: '',
      running: true,
    }));
    try {
      const r = await window.electron.terminal.run(
        cmd,
        active.cwd || undefined,
        active.profile,
      );
      updateTerminal(id, (prev) => ({
        cwd: r.cwd,
        lines: r.clear
          ? []
          : [
              ...prev.lines,
              ...(r.output
                ? [{ type: 'out' as const, text: r.output.replace(/\s+$/, '') }]
                : []),
            ],
      }));
    } catch (e: any) {
      updateTerminal(id, (prev) => ({
        lines: [
          ...prev.lines,
          { type: 'out', text: `⚠️ ${e?.message || e}` },
        ],
      }));
    } finally {
      updateTerminal(id, { running: false });
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
      <div className="terminal-body" ref={bodyRef}>
        {active.lines.map((line, i) => (
          <div key={i} className={`term-line ${line.type}`}>
            {line.text}
          </div>
        ))}
        <div className="term-prompt">
          <span className="term-ps">{`PS ${active.cwd || ''}>`}</span>
          <input
            aria-label="终端命令"
            value={active.input}
            onChange={(e) => updateTerminal(active.id, { input: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void run(active.input);
              }
            }}
            autoFocus
            spellCheck={false}
          />
          {active.running ? (
            <span className="terminal-running">运行中…</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
