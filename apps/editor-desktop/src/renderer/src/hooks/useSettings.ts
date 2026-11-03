import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentMode,
  AppConfig,
  ProviderStatus,
  WorkspaceNode,
} from '../mode/types';
import type { AgentBackend } from './useAgentRun';
import { DEFAULT_LOCAL_MODEL } from '../models';
import { flattenFiles } from '../files';

/** 配置 / 提供商 / 模型相关状态与操作 */
export function useSettings({
  backend,
  mode,
  nodes,
  reload,
  setError,
}: {
  backend: AgentBackend;
  mode: AgentMode;
  nodes: WorkspaceNode[];
  reload: (b?: AgentBackend) => Promise<void>;
  setError: (v: string) => void;
}) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus[]>([]);

  const refreshProviders = useCallback(async () => {
    try {
      const s = await window.electron.providers.status();
      setProviderStatus(s.providers);
    } catch {
      setProviderStatus([]);
    }
  }, []);

  useEffect(() => {
    void window.electron.config
      .get()
      .then(setConfig)
      .catch((e) => setError(e?.message || String(e)));
  }, [setError]);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const availableModels = useMemo(
    () =>
      providerStatus
        .filter((p) => p.hasKey)
        .flatMap((p) =>
          p.models.map((m) => ({
            id: m.id,
            label: m.name || m.id,
          })),
        ),
    [providerStatus],
  );

  const allModels = useMemo(
    () =>
      (config?.providers ?? []).flatMap((p) =>
        p.models.map((m) => ({
          id: m.id,
          label: m.name || m.id,
        })),
      ),
    [config],
  );

  const modelOptions = mode === 'local' ? availableModels : allModels;

  const modelGroups = useMemo(() => {
    const providers =
      mode === 'local'
        ? providerStatus.filter((p) => p.hasKey)
        : (config?.providers ?? []);
    return providers
      .map((p) => ({
        provider: p.name,
        models: p.models.map((m) => ({
          id: m.id,
          label: m.name || m.id,
        })),
      }))
      .filter((g) => g.models.length > 0);
  }, [mode, providerStatus, config]);

  const modelConfigured =
    !config || mode === 'remote' || availableModels.length > 0;

  const saveConfig = async (next: AppConfig) => {
    const saved = await window.electron.config.set(next);
    setConfig(saved);
    await refreshProviders();
    await reload(backend);
  };

  const currentModel =
    mode === 'local'
      ? config?.selectedModel || DEFAULT_LOCAL_MODEL
      : config?.remote.model || config?.selectedModel || DEFAULT_LOCAL_MODEL;

  const updateModel = async (model: string) => {
    if (!config) return;
    const next: AppConfig =
      mode === 'local'
        ? { ...config, selectedModel: model }
        : { ...config, remote: { ...config.remote, model } };
    const saved = await window.electron.config.set(next);
    setConfig(saved);
    await refreshProviders();
  };

  const toggleApproval = () => {
    if (!config) return;
    const next: AppConfig = {
      ...config,
      approvalMode: config.approvalMode === 'auto' ? 'ask' : 'auto',
    };
    void saveConfig(next);
  };

  // 当前选中的本地模型没有 key 时，自动切到第一个可用模型
  useEffect(() => {
    if (!config || mode !== 'local') return;
    if (
      availableModels.length &&
      !availableModels.some((m) => m.id === config.selectedModel)
    ) {
      const next = { ...config, selectedModel: availableModels[0].id };
      void window.electron.config.set(next).then(setConfig);
    }
  }, [config, mode, availableModels]);

  const mentionFiles = useMemo(() => flattenFiles(nodes), [nodes]);

  return {
    config,
    setConfig,
    providerStatus,
    availableModels,
    allModels,
    modelOptions,
    modelGroups,
    modelConfigured,
    currentModel,
    saveConfig,
    updateModel,
    toggleApproval,
    mentionFiles,
  };
}
