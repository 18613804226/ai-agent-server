import { useState } from 'react';
import type {
  AppConfig,
  ProviderConfig,
  ProviderStatus,
} from '../mode/types';
import { ProviderModal } from './ProviderModal';
import { DatabaseSettings } from './DatabaseSettings';
import { DEFAULT_MODEL_ID } from '../../../shared/providers';

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
      await onSave({
        ...draft,
        commandApproval: draft.commandApproval ?? 'ask',
        fileApproval: draft.fileApproval ?? 'ask',
        databaseApproval: draft.databaseApproval ?? 'ask',
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
          <span>设置</span>
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
              API Key 可直接填在提供商里（会保存到本地配置文件），也可只填环境变量名，从
              <code> apps/editor-desktop/.env </code>
              读取（修改后需重启应用）。未配置 key 的提供商不会出现在模型选择里。
            </p>
            <p className="hint">
              默认只内置免费模型 <code>{DEFAULT_MODEL_ID}</code>；通义/付费模型不预置，
              需要更好的模型请自行添加提供商。
            </p>
          </section>

          <section className="settings-section">
            <div className="section-head">
              <h4>工具审批</h4>
            </div>
            <p className="hint">
              开关控制「执行前是否需要你确认」：<strong>开 = 每次询问</strong>
              （弹出确认框，你可以拒绝），<strong>关 = 自动放行</strong>
              （直接执行，不再询问）。只读操作（读文件、查询数据库）始终不询问。
            </p>
            <ApprovalToggle
              title="命令执行"
              description="run_terminal 执行命令前弹出确认（危险命令必须手动放行）"
              value={draft.commandApproval}
              onChange={(v) => setDraft((d) => ({ ...d, commandApproval: v }))}
            />
            <ApprovalToggle
              title="文件写操作"
              description="写、删、移动文件前弹出确认，可在 diff 里逐块接受/拒绝"
              value={draft.fileApproval}
              onChange={(v) => setDraft((d) => ({ ...d, fileApproval: v }))}
            />
            <ApprovalToggle
              title="数据库写操作"
              description="execute_sql 执行写入前弹出确认；query_database 只读，始终放行"
              value={draft.databaseApproval}
              onChange={(v) => setDraft((d) => ({ ...d, databaseApproval: v }))}
            />
          </section>

          <DatabaseSettings />

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

/**
 * 审批开关：开 = ask（每次询问），关 = auto（自动放行）。
 * 开关本身只有「要/不要确认」一种语义，旁边用文字徽标把当前状态写出来，
 * 避免用户猜「开着是放行还是拦截」。
 */
function ApprovalToggle({
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description: string;
  value: 'ask' | 'auto';
  onChange: (value: 'ask' | 'auto') => void;
}) {
  const ask = value === 'ask';
  return (
    <div className="approval-row">
      <div className="approval-row-text">
        <strong>{title}</strong>
        <span className="muted small">{description}</span>
      </div>
      <div className="approval-row-control">
        <span className={`approval-state ${ask ? 'is-ask' : 'is-auto'}`}>
          {ask ? '每次询问' : '自动放行'}
        </span>
        <label className="switch">
          <input
            type="checkbox"
            checked={ask}
            onChange={(e) => onChange(e.target.checked ? 'ask' : 'auto')}
          />
          <span className="switch-slider" />
        </label>
      </div>
    </div>
  );
}
