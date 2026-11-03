import { useState } from 'react';
import { PROVIDER_PRESETS } from '../../../shared/providers';
import type { ModelConfig, ProviderConfig } from '../mode/types';
import { SelectMenu } from './SelectMenu';

const EMPTY: ProviderConfig = {
  id: '',
  name: '',
  api: 'openai-compatible',
  baseUrl: '',
  apiKeyEnv: '',
  apiKey: '',
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
      // Electron IPC 错误会带 "Error invoking remote method 'xxx': " 前缀，去掉更直观
      const msg = String(e?.message || e).replace(
        /^Error invoking remote method '[^']+':\s*/,
        '',
      );
      setError(`获取模型失败：${msg}`);
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
    const directKey = (draft.apiKey ?? '').trim();
    if (!directKey && !draft.apiKeyEnv.trim()) {
      setError('请填写 API Key 或 API Key 环境变量');
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
        apiKey: directKey || undefined,
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
    <div className="modal-backdrop">
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          <span>{provider ? '编辑提供商' : '添加提供商'}</span>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="m4 4 8 8m0-8-8 8" />
            </svg>
          </button>
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
            <SelectMenu
              value={draft.api}
              options={[
                ...(!PROVIDER_PRESETS.some((p) => p.id === draft.api) && draft.api
                  ? [{ value: draft.api, label: draft.api }]
                  : []),
                ...PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label })),
              ]}
              onChange={applyPreset}
              placeholder="选择预设"
            />
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
            API Key
            <input
              value={draft.apiKey ?? ''}
              onChange={(e) => update({ apiKey: e.target.value })}
              placeholder="直接填 key（会保存到本地配置）"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="hint">
              填了这里就直接用；留空则从下方环境变量读取
            </span>
          </label>
          <label className="field">
            API Key 环境变量（可选）
            <input
              value={draft.apiKeyEnv}
              onChange={(e) => update({ apiKeyEnv: e.target.value })}
              placeholder="OPENAI_API_KEY"
            />
            <span className="hint">
              环境变量名（如 <code>OPENAI_API_KEY</code>）；上面填了 API Key
              时可留空，也可在 <code> apps/editor-desktop/.env </code>{' '}
              里配置（修改后需重启应用）
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
