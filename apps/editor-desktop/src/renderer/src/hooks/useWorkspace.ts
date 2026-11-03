import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FileChange,
  WorkspaceNode,
  WorkspaceRootInfo,
} from '../mode/types';
import type { AgentBackend } from './useAgentRun';
import type { EditorTab } from './useAgentRun';
import type { ChatMsg } from '../components/ChatMessage';

/** 工作区：根目录、文件树、打开/移除/清空 */
export function useWorkspace({
  backend,
  setActiveFile,
  setFileContentState,
  setSavedContentState,
  setEditorTabs,
  setActiveDiff,
  setChanges,
  updateSession,
  setError,
}: {
  backend: AgentBackend;
  setActiveFile: (v: string) => void;
  setFileContentState: (v: string) => void;
  setSavedContentState: (v: string) => void;
  setEditorTabs: (
    v: EditorTab[] | ((prev: EditorTab[]) => EditorTab[]),
  ) => void;
  setActiveDiff: (v: FileChange | null) => void;
  setChanges: (v: FileChange[] | ((prev: FileChange[]) => FileChange[])) => void;
  updateSession: (patch: { messages?: ChatMsg[] }) => void;
  setError: (v: string) => void;
}) {
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [roots, setRoots] = useState<WorkspaceRootInfo[]>([]);
  const [nodes, setNodes] = useState<WorkspaceNode[]>([]);

  const reload = useCallback(
    async (b = backend) => {
      try {
        setError('');
        const list = await b.workspace.roots();
        setRoots(list);
        setWorkspaceRoot(list[0]?.path || '');
        setNodes(await b.workspace.tree());
      } catch (e: any) {
        setError(e?.message || String(e));
        setNodes([]);
      }
    },
    [backend, setError],
  );

  // 用 ref 持有 updateSession，避免切换会话（activeId 变化）时重复触发重置
  const updateSessionRef = useRef(updateSession);
  updateSessionRef.current = updateSession;

  useEffect(() => {
    backend.transport.abort();
    setActiveFile('');
    setFileContentState('');
    setSavedContentState('');
    setEditorTabs([]);
    setError('');
    setChanges([]);
    setActiveDiff(null);
    updateSessionRef.current({ messages: [] });
    void reload(backend);
  }, [
    backend,
    reload,
    setActiveFile,
    setFileContentState,
    setSavedContentState,
    setEditorTabs,
    setError,
    setChanges,
    setActiveDiff,
  ]);

  const openFolder = async () => {
    if (!backend.workspace.open) return;
    try {
      await backend.workspace.open();
      await reload();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const removeRoot = async (name: string) => {
    const root = roots.find((r) => r.name === name);
    if (!root || !backend.workspace.removeRoot) return;
    try {
      await backend.workspace.removeRoot(root.path);
      await reload();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const clearWorkspace = async () => {
    try {
      await backend.workspace.clear?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
    backend.transport.abort();
    setWorkspaceRoot('');
    setRoots([]);
    setNodes([]);
    setActiveFile('');
    setFileContentState('');
    setSavedContentState('');
    setEditorTabs([]);
    setActiveDiff(null);
    setChanges([]);
    updateSession({ messages: [] });
    setError('');
  };

  return {
    workspaceRoot,
    roots,
    nodes,
    reload,
    openFolder,
    removeRoot,
    clearWorkspace,
  };
}
