import type {
  AppConfig,
  ChatEvent,
  ProviderConfig,
  ProviderStatus,
} from './mode/types';

export {};

declare global {
  interface Window {
    electron: {
      versions: { node: string; chrome: string; electron: string };
      config: {
        get(): Promise<AppConfig>;
        set(next: AppConfig): Promise<AppConfig>;
      };
      providers: {
        status(): Promise<{
          selectedModel: string;
          providers: ProviderStatus[];
        }>;
        fetchModels(provider: ProviderConfig): Promise<string[]>;
      };
      workspace: {
        roots(): Promise<Array<{ name: string; path: string }>>;
        open(): Promise<Array<{ name: string; path: string }>>;
        remove(
          path: string,
        ): Promise<Array<{ name: string; path: string }>>;
        root(): Promise<string | null>;
        tree(): Promise<{ root: string; nodes: unknown[] }>;
        read(path: string): Promise<{ path: string; content: string }>;
        write(path: string, content: string): Promise<{ ok: boolean }>;
        createFile(path: string): Promise<{ ok: boolean }>;
        createDir(path: string): Promise<{ ok: boolean }>;
        delete(path: string): Promise<{ ok: boolean }>;
        rename(from: string, to: string): Promise<{ ok: boolean }>;
        clear(): Promise<{ ok: boolean }>;
      };
      terminal: {
        cwd(): Promise<string>;
        run(
          command: string,
        ): Promise<{ output: string; cwd: string; clear?: boolean }>;
      };
      agent: {
        run(
          query: string,
          history?: Array<{ role: 'user' | 'assistant'; content: string }>,
        ): Promise<void>;
        execTool(
          name: string,
          args: Record<string, unknown>,
        ): Promise<string>;
        abort(): Promise<void>;
        onEvent(cb: (ev: ChatEvent) => void): () => void;
      };
    };
  }
}
