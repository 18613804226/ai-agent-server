import { useState } from 'react';
import { PROVIDER_PRESETS } from '../../../shared/providers';
import type { ModelConfig, ProviderConfig } from '../mode/types';

const EMPTY: ProviderConfig = {
  id: '',
  name: '',
  api: 'openai-compatible',
  baseUrl: '',
  apiKeyEnv: '',
  models: [],
};

export function ProviderModal({
  provider,
  onClose,
  onSave,
}: {
  provider?: ProviderConfig;
  onClose: () => void;
  onSave: (provider: ProviderConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProviderConfig>(
    structuredClone(provider ?? EMPTY),
  );
  const [error, setError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<ProviderConfig>) =>
    setDraft((d) => ({ ...d, ...patch }));

  /** 选择预设：自动填 baseUrl / key 环境变量 / 默认模型 */
  const applyPreset = (id: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setDraft((d) => ({
      ...d,
      api: preset.id,
      baseUrl: preset.baseUrl,
      apiKeyEnv: preset.apiKeyEnv,
      requiresKey: preset.requiresKey,
      models: d.models.length ? d.models : structuredClone(preset.models),
    }));
  };

  const updateModel = (index: number, patch: Partial<ModelConfig>) =>
    setDraft((d) => ({
      ...d,
      models: d.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    }));

  const addModel = () =>
    setDraft((d) => ({ ...d, models: [...d.models, { id: '', name: '' }] }));

  const removeModel = (index: number) =>
    setDraft((d) => ({
      ...d,
      models: d.models.filter((_, i) => i !== index),
    }));

  const toggleAll = (key: 'reasoning' | 'vision') =>
    setDraft((d) => {
      const next = !d.models.every((m) => m[key]);
      return {
        ...d,
        models: d.models.map((m) => ({ ...m, [key]: next })),
      };
    });

  const fetchModels = async () => {
    setFetching(true);
    setError('');
    try {
      const ids = await window.electron.providers.fetchModels(draft);
      setDraft((d) => ({
        ...d,
        models: ids.map((id) => ({ id, name: id })),
      }));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    const id = draft.id.trim();
    if (!/^[a-z0-9_-]+$/.test(id)) {
      setError('提供商 ID 只能包含小写字母、数字、连字符或下划线');
      return;
    }
    if (!draft.name.trim()) {
      setError('显示名称不能为空');
      return;
    }
    if (!draft.baseUrl.trim()) {
      setError('基础 URL 不能为空');
      return;
    }
    if (!draft.apiKeyEnv.trim()) {
      setError('API Key 环境变量不能为空');
      return;
    }
    const models = draft.models
      .map((m) => {
        const mid = m.id.trim();
        return { ...m, id: mid, name: (m.name ?? '').trim() || mid };
      })
      .filter((m) => m.id);
    if (!models.length) {
      setError('至少添加一个模型');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await onSave({
        ...draft,
        id,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        apiKeyEnv: draft.apiKeyEnv.trim(),
        models,
      });
      onClose();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          {provider ? '编辑提供商' : '添加提供商'}
        </div>
        <div className="modal-body">
          <label className="field">
            提供商 ID
            <input
              value={draft.id}
              onChange={(e) => update({ id: e.target.value })}
              placeholder="myprovider"
            />
            <span className="hint">小写字母、数字、连字符或下划线</span>
          </label>
          <label className="field">
            显示名称
            <input
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="我的 AI 提供商"
            />
          </label>
          <label className="field">
            Provider API
            <select
              value={draft.api}
              onChange={(e) => applyPreset(e.target.value)}
            >
              {!PROVIDER_PRESETS.some((p) => p.id === draft.api) ? (
                <option value={draft.api}>{draft.api || '选择预设'}</option>
              ) : null}
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            基础 URL
            <input
              value={draft.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
              placeholder="https://api.myprovider.com/v1"
            />
          </label>
          <label className="field">
            API Key 环境变量
            <input
              value={draft.apiKeyEnv}
              onChange={(e) => update({ apiKeyEnv: e.target.value })}
              placeholder="OPENAI_API_KEY"
            />
            <span className="hint">
              key 不写入配置，运行时从该环境变量读取
              {draft.requiresKey === false ? '（本地服务可留空）' : ''}
            </span>
          </label>

          <div className="models-header">
            <span>模型</span>
            <div className="models-actions">
              <button
                className="ghost small"
                onClick={() => void fetchModels()}
                disabled={fetching}
              >
                {fetching ? '获取中…' : '获取模型'}
              </button>
              <button
                className="ghost small"
                onClick={() => toggleAll('reasoning')}
              >
                切换所有推理
              </button>
              <button
                className="ghost small"
                onClick={() => toggleAll('vision')}
              >
                切换所有图像
              </button>
            </div>
          </div>

          <div className="model-table">
            <div className="model-row head">
              <span>ID</span>
              <span>名称</span>
              <span>推理</span>
              <span>图片</span>
              <span />
            </div>
            {draft.models.map((m, i) => (
              <div className="model-row" key={i}>
                <input
                  value={m.id}
                  onChange={(e) => updateModel(i, { id: e.target.value })}
                  placeholder="model-id"
                />
                <input
                  value={m.name ?? ''}
                  onChange={(e) => updateModel(i, { name: e.target.value })}
                  placeholder="显示名称"
                />
                <input
                  type="checkbox"
                  checked={Boolean(m.reasoning)}
                  onChange={(e) =>
                    updateModel(i, { reasoning: e.target.checked })
                  }
                />
                <input
                  type="checkbox"
                  checked={Boolean(m.vision)}
                  onChange={(e) => updateModel(i, { vision: e.target.checked })}
                />
                <button
                  className="ghost small"
                  onClick={() => removeModel(i)}
                >
                  删除
                </button>
              </div>
            ))}
            <button className="ghost small add-model" onClick={addModel}>
              + 添加模型
            </button>
          </div>

          {error ? <div className="modal-error">⚠️ {error}</div> : null}
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
