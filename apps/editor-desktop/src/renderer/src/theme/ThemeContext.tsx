import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_KEY = 'editor_theme';

function systemTheme(): Theme {
  if (typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' ? saved : systemTheme();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const prevTheme = useRef<Theme | null>(null);

  // layout effect：在浏览器绘制前把 CSS 变量、color-scheme、原生 IPC 一起落定，
  // 避免「网页先变、标题栏和 Monaco 慢一帧」。切换瞬间还统一禁用过渡。
  useLayoutEffect(() => {
    const root = document.documentElement;
    const switching =
      prevTheme.current !== null && prevTheme.current !== theme;
    if (switching) root.classList.add('theme-switching');

    // 同步 IPC 先发出：主进程在系统层刷完窗口按钮底色后才返回，
    // 随后同一帧里网页才写入新的 CSS 变量，两者一起在下次绘制中生效
    window.electron?.setTheme?.(theme);
    root.dataset.theme = theme;
    root.style.colorScheme = theme;

    if (switching) {
      // 强制这一帧应用「禁用过渡」，颜色一次性翻完；下一帧恢复 hover 等动效
      void root.offsetWidth;
      requestAnimationFrame(() => {
        root.classList.remove('theme-switching');
      });
    }
    prevTheme.current = theme;
  }, [theme]);

  // 用户还没手动选过时，跟随系统明暗变化；一旦点过按钮就固定下来
  useEffect(() => {
    if (localStorage.getItem(THEME_KEY)) return;
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (event: MediaQueryListEvent) => {
      setThemeState(event.matches ? 'light' : 'dark');
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: (next) => {
        setThemeState(next);
        localStorage.setItem(THEME_KEY, next);
      },
      toggleTheme: () => {
        setThemeState((current) => {
          const next: Theme = current === 'dark' ? 'light' : 'dark';
          localStorage.setItem(THEME_KEY, next);
          return next;
        });
      },
    }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return ctx;
}
