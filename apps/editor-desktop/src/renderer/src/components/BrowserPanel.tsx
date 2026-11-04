import { useEffect, useRef, useState } from 'react';

/**
 * 内置浏览器面板：主进程 WebContentsView 嵌入。
 * 用 ResizeObserver 持续同步视图位置，避免黑屏/错位。
 */
export function BrowserPanel({
  initialUrl,
  onClose,
}: {
  initialUrl: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabIdRef = useRef<number | null>(null);
  const [address, setAddress] = useState(initialUrl);

  useEffect(() => {
    let disposed = false;

    const syncBounds = () => {
      const id = tabIdRef.current;
      const el = containerRef.current;
      if (id == null || !el) return;
      const rect = el.getBoundingClientRect();
      void window.electron.browser.setBounds(id, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    void window.electron.browser
      .create(initialUrl)
      .then((id) => {
        if (disposed) {
          void window.electron.browser.close(id);
          return;
        }
        tabIdRef.current = id;
        // 等布局完成后同步位置
        requestAnimationFrame(syncBounds);
        setTimeout(syncBounds, 100);
      })
      .catch(() => {});

    const ro = new ResizeObserver(syncBounds);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', syncBounds);

    return () => {
      disposed = true;
      ro.disconnect();
      window.removeEventListener('resize', syncBounds);
      const id = tabIdRef.current;
      tabIdRef.current = null;
      if (id != null) void window.electron.browser.close(id);
    };
  }, [initialUrl]);

  const go = () => {
    const id = tabIdRef.current;
    if (id == null) return;
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(address)) return;
    void window.electron.browser.navigate(id, address);
  };

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <button
          type="button"
          title="刷新"
          aria-label="刷新"
          onClick={go}
        >
          ↻
        </button>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
          spellCheck={false}
          aria-label="浏览器地址"
        />
        <button
          type="button"
          className="browser-close"
          title="关闭浏览器"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div ref={containerRef} className="browser-container" />
    </div>
  );
}
