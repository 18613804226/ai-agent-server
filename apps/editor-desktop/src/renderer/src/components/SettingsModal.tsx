import { useState } from 'react';
import type {
  AppConfig,
  ProviderConfig,
  ProviderStatus,
} from '../mode/types';
import { ProviderModal } from './ProviderModal';

export function SettingsModal({
  config,
  status,
  onClose,
  onSave,
}: {
  config: AppConfig;
  status: ProviderStatus[];
  onClose: () => void;
  onSave: (next: AppConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AppConfig>(structuredClone(config));
  const [editing, setEditing] = useState<ProviderConfig | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const saveProvider = async (provider: ProviderConfig) => {
    setDraft((d) => {
      const exists = d.providers.some((p) => p.id === provider.id);
      const providers = exists
        ? d.providers.map((p) => (p.id === provider.id ? provider : p))
        : [...d.providers, provider];
      return { ...d, providers };
    });
  };

  const removeProvider = (id: string) => {
    setDraft((d) => ({
      ...d,
      providers: d.providers.filter((p) => p.id !== id),
    }));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(draft);
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
        <div className="modal-title">设置</div>
        <div className="modal-body">
          <section className="settings-section">
            <div className="section-head">
              <h4>提供商</h4>
              <button
                className="ghost small"
                onClick={() => setEditing('new')}
              >
                添加提供商
              </button>
            </div>

            {draft.providers.length === 0 ? (
              <div className="muted small">还没有提供商</div>
            ) : (
              <ul className="provider-list">
                {draft.providers.map((p) => {
                  const hasKey = status.find((s) => s.id === p.id)?.hasKey;
                  return (
                  <li key={p.id}>
                    <div className="provider-info">
                      <div className="provider-name">
                        {p.name}{' '}
                        <span className="muted small">{p.id}</span>
                      </div>
                      <div className="muted small">
                        {p.baseUrl} · {p.apiKeyEnv}
                        {hasKey ? '（已配置）' : '（未配置）'} ·{' '}
                        {p.models.length} 个模型
                      </div>
                    </div>
                    <div className="provider-actions">
                      <button
                        className="ghost small"
                        onClick={() => setEditing(p)}
                      >
                        编辑
                      </button>
                      <button
                        className="ghost small"
                        onClick={() => removeProvider(p.id)}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                  );
                })}
              </ul>
            )}

            <p className="hint">
              API Key 从环境变量读取，不写进配置文件。在
              <code> apps/editor-desktop/.env </code>
              里配置（参考 <code>.env.example</code>），或启动 Electron
              前设置环境变量；修改后需重启应用。未配置 key 的提供商不会出现在模型
              选择里。
            </p>
            <p className="hint">
              默认只内置免费模型 <code>glm-4-flash</code>；通义/付费模型不预置，
              需要更好的模型请自行添加提供商。
            </p>
          </section>

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

      {editing ? (
        <ProviderModal
          provider={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={saveProvider}
        />
      ) : null}
    </div>
  );
}
