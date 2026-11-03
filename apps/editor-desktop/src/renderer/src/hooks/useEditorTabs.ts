import { useCallback, useRef, useState } from 'react';
import type { FileChange } from '../mode/types';
import type { AgentBackend, EditorTab } from './useAgentRun';

export interface TabClosePrompt {
  paths: string[];
  dirtyPaths: string[];
  index: number;
}

/** 编辑器标签：打开/关闭/保存/切换，以及未保存关闭确认 */
export function useEditorTabs({
  backend,
  setActiveDiff,
  setError,
}: {
  backend: AgentBackend;
  setActiveDiff: (v: FileChange | null) => void;
  setError: (v: string) => void;
}) {
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [tabContextMenu, setTabContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const [tabClosePrompt, setTabClosePrompt] = useState<TabClosePrompt | null>(
    null,
  );
  const [tabCloseSaving, setTabCloseSaving] = useState(false);
  const [tabCloseError, setTabCloseError] = useState('');
  const [activeFile, setActiveFile] = useState('');
  const [fileContent, setFileContentState] = useState('');
  const [savedContent, setSavedContentState] = useState('');

  const openFileRequestRef = useRef(0);
  const tabClosePromptBusyRef = useRef(false);

  const setFileContent = (content: string) => {
    setFileContentState(content);
    if (activeFile) {
      setEditorTabs((tabs) =>
        tabs.map((tab) =>
          tab.path === activeFile ? { ...tab, content } : tab,
        ),
      );
    }
  };

  const setSavedContent = (content: string) => {
    setSavedContentState(content);
    if (activeFile) {
      setEditorTabs((tabs) =>
        tabs.map((tab) =>
          tab.path === activeFile ? { ...tab, savedContent: content } : tab,
        ),
      );
    }
  };

  const openFile = async (path: string) => {
    const requestId = ++openFileRequestRef.current;
    try {
      setActiveDiff(null);
      const existing = editorTabs.find((tab) => tab.path === path);
      if (existing) {
        setActiveFile(path);
        setFileContentState(existing.content);
        setSavedContentState(existing.savedContent);
        return;
      }

      const content = await backend.workspace.readFile(path);
      setEditorTabs((tabs) =>
        tabs.some((tab) => tab.path === path)
          ? tabs
          : [...tabs, { path, content, savedContent: content }],
      );
      if (requestId === openFileRequestRef.current) {
        setActiveFile(path);
        setFileContentState(content);
        setSavedContentState(content);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const removeEditorTabs = (paths: string[]) => {
    const pathsToClose = new Set(paths);
    const nextTabs = editorTabs.filter((tab) => !pathsToClose.has(tab.path));
    setEditorTabs(nextTabs);
    if (!pathsToClose.has(activeFile)) return;

    const closedIndex = editorTabs.findIndex((tab) => tab.path === activeFile);
    const nextTab = nextTabs[Math.max(0, closedIndex - 1)];
    setActiveDiff(null);
    setActiveFile(nextTab?.path ?? '');
    setFileContentState(nextTab?.content ?? '');
    setSavedContentState(nextTab?.savedContent ?? '');
  };

  const requestCloseEditorTabs = (paths: string[]) => {
    const tabsToClose = editorTabs.filter((tab) => paths.includes(tab.path));
    if (!tabsToClose.length) return;

    const dirtyPaths = tabsToClose
      .filter((tab) => tab.content !== tab.savedContent)
      .map((tab) => tab.path);
    if (!dirtyPaths.length) {
      removeEditorTabs(tabsToClose.map((tab) => tab.path));
      return;
    }

    setTabCloseError('');
    setTabClosePrompt({
      paths: tabsToClose.map((tab) => tab.path),
      dirtyPaths,
      index: 0,
    });
  };

  const respondToTabClosePrompt = async (
    choice: 'save' | 'discard' | 'cancel',
  ) => {
    const prompt = tabClosePrompt;
    if (!prompt || tabClosePromptBusyRef.current) return;
    if (choice === 'cancel') {
      setTabClosePrompt(null);
      setTabCloseError('');
      return;
    }

    tabClosePromptBusyRef.current = true;
    setTabCloseSaving(true);
    try {
      const path = prompt.dirtyPaths[prompt.index];
      if (choice === 'save') {
        const tab = editorTabs.find((item) => item.path === path);
        if (tab) {
          if (!backend.workspace.writeFile) {
            setTabCloseError(`当前工作区不支持保存文件：${path}`);
            return;
          }
          await backend.workspace.writeFile(path, tab.content);
          setEditorTabs((tabs) =>
            tabs.map((item) =>
              item.path === path
                ? { ...item, savedContent: item.content }
                : item,
            ),
          );
          if (activeFile === path) setSavedContentState(tab.content);
        }
      }

      if (prompt.index + 1 < prompt.dirtyPaths.length) {
        setTabClosePrompt({ ...prompt, index: prompt.index + 1 });
      } else {
        setTabClosePrompt(null);
        removeEditorTabs(prompt.paths);
      }
      setTabCloseError('');
      setError('');
    } catch (e: unknown) {
      setTabCloseError(e instanceof Error ? e.message : String(e));
    } finally {
      tabClosePromptBusyRef.current = false;
      setTabCloseSaving(false);
    }
  };

  const selectEditorTab = (path: string) => {
    openFileRequestRef.current += 1;
    const tab = editorTabs.find((item) => item.path === path);
    if (!tab) return;
    setActiveDiff(null);
    setActiveFile(path);
    setFileContentState(tab.content);
    setSavedContentState(tab.savedContent);
  };

  const dirty = Boolean(activeFile) && fileContent !== savedContent;

  const saveCurrent = useCallback(async () => {
    if (!activeFile || !backend.workspace.writeFile) return;
    try {
      await backend.workspace.writeFile(activeFile, fileContent);
      setSavedContent(fileContent);
      setError('');
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [activeFile, fileContent, backend, setSavedContent, setError]);

  return {
    editorTabs,
    setEditorTabs,
    tabContextMenu,
    setTabContextMenu,
    tabClosePrompt,
    setTabClosePrompt,
    tabCloseSaving,
    setTabCloseSaving,
    tabCloseError,
    setTabCloseError,
    activeFile,
    setActiveFile,
    fileContent,
    setFileContentState,
    savedContent,
    setSavedContentState,
    setFileContent,
    setSavedContent,
    openFile,
    removeEditorTabs,
    requestCloseEditorTabs,
    respondToTabClosePrompt,
    selectEditorTab,
    saveCurrent,
    dirty,
  };
}
