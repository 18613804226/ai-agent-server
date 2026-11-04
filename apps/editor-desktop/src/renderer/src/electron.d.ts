import type {
  AppConfig,
  ChatEvent,
  ProviderConfig,
  ProviderStatus,
} from './mode/types';

export {};

export interface RunCheckpointInfo {
  id: string;
  query: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  context?: {
    activeFile?: string;
    activeContent?: string;
    selection?: string;
  };
  changes: Array<{
    path: string;
    kind: 'created' | 'modified' | 'deleted' | 'renamed';
    before?: string;
    after?: string;
    from?: string;
  }>;
  state: string;
  updatedAt: number;
}

export interface RunStateInfo {
  state: string;
  checkpoint: RunCheckpointInfo | null;
}

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
          cwd?: string,
          profile?: string,
        ): Promise<{ output: string; cwd: string; clear?: boolean }>;
        spawn(
          command: string,
          cwd?: string,
          profile?: string,
        ): Promise<{ pid: number }>;
        kill(): Promise<boolean>;
        onOutput(
          cb: (ev: {
            type: 'data' | 'clear' | 'cwd' | 'exit';
            data?: string;
            cwd?: string;
            code?: number;
          }) => void,
        ): () => void;
      };
      agent: {
        run(
          query: string,
          history?: Array<{ role: 'user' | 'assistant'; content: string }>,
          context?: {
            activeFile?: string;
            activeContent?: string;
            selection?: string;
          },
          images?: string[],
        ): Promise<void>;
        execTool(
          name: string,
          args: Record<string, unknown>,
        ): Promise<string>;
        abort(): Promise<void>;
        respondApproval(id: string, approved: boolean): Promise<boolean>;
        undoAgent(): Promise<{ restored: string[]; failed: string[] }>;
        getChanges(): Promise<
          Array<{
            path: string;
            kind: 'created' | 'modified' | 'deleted' | 'renamed';
            before?: string;
            after?: string;
            from?: string;
          }>
        >;
        resetChanges(): Promise<boolean>;
        getRunState(): Promise<RunStateInfo>;
        pause(): Promise<RunStateInfo>;
        cancel(): Promise<RunStateInfo>;
        resume(): Promise<RunStateInfo>;
        onEvent(cb: (ev: ChatEvent) => void): () => void;
      };
      chat: {
        getSessions(): Promise<unknown>;
        saveSessions(sessions: unknown): Promise<void>;
      };
      browser: {
        create(url: string): Promise<number>;
        navigate(
          id: number,
          url: string,
        ): Promise<{ ok: boolean; url: string }>;
        setBounds(
          id: number,
          bounds: { x: number; y: number; width: number; height: number },
        ): Promise<void>;
        close(id: number): Promise<void>;
      };
    };
  }
}
