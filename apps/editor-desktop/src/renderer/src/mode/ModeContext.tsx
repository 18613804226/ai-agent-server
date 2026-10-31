import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AgentMode } from './types';

interface ModeContextValue {
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;
}

const ModeContext = createContext<ModeContextValue | null>(null);
const MODE_KEY = 'editor_agent_mode';

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AgentMode>(() => {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === 'remote' ? 'remote' : 'local';
  });

  const value = useMemo<ModeContextValue>(
    () => ({
      mode,
      setMode: (next) => {
        setModeState(next);
        localStorage.setItem(MODE_KEY, next);
      },
    }),
    [mode],
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useMode 必须在 ModeProvider 内使用');
  return ctx;
}
