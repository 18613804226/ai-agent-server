import { useEffect, useRef, useState } from 'react';

interface Line {
  type: 'cmd' | 'out';
  text: string;
}

export function Terminal({ onClose }: { onClose: () => void }) {
  const [lines, setLines] = useState<Line[]>([
    { type: 'out', text: '本地终端：命令在工作区目录执行，支持 cd / clear。' },
  ]);
  const [input, setInput] = useState('');
  const [cwd, setCwd] = useState('');
  const [running, setRunning] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.electron.terminal
      .cwd()
      .then(setCwd)
      .catch(() => {});
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [lines]);

  const prompt = `PS ${cwd || ''}>`;

  const run = async () => {
    const command = input.trim();
    if (!command || running) return;
    setInput('');
    setLines((l) => [...l, { type: 'cmd', text: `${prompt} ${command}` }]);
    setRunning(true);
    try {
      const r = await window.electron.terminal.run(command);
      setCwd(r.cwd);
      if (r.clear) {
        setLines([]);
      } else if (r.output) {
        setLines((l) => [
          ...l,
          { type: 'out', text: r.output.replace(/\s+$/, '') },
        ]);
      }
    } catch (e: any) {
      setLines((l) => [...l, { type: 'out', text: `⚠️ ${e?.message || e}` }]);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="terminal">
      <div className="terminal-header">
        <span className="terminal-title">
          <svg
            className="terminal-icon"
            viewBox="0 0 16 16"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <path d="m4 6 2 2-2 2m4 0h3" />
          </svg>
          终端
        </span>
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
        {lines.map((line, i) => (
          <div key={i} className={`term-line ${line.type}`}>
            {line.text}
          </div>
        ))}
        <div className="term-prompt">
          <span className="term-ps">{prompt}</span>
          <input
            aria-label="终端命令"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
            autoFocus
            spellCheck={false}
          />
          {running ? <span className="terminal-running">运行中…</span> : null}
        </div>
      </div>
    </div>
  );
}
