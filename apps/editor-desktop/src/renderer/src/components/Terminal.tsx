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
        <span>终端</span>
        <button className="ghost small" onClick={onClose}>
          关闭
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
          {running ? <span className="muted small">运行中…</span> : null}
        </div>
      </div>
    </div>
  );
}
