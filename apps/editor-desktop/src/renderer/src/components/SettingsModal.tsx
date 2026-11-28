import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppConfig,
  ProviderConfig,
  ProviderStatus,
} from '../mode/types';
import { ProviderModal } from './ProviderModal';
import { DatabaseSettings } from './DatabaseSettings';
import { McpSettings } from './McpSettings';
import { DEFAULT_MODEL_ID } from '../../../shared/providers';
import './SettingsModal.css';

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

  // 是否有未保存的更改（不含 DatabaseSettings，它自行管理状态）
  const initialSnapshot = useMemo(() => JSON.stringify(config), [config]);
  const dirty = JSON.stringify(draft) !== initialSnapshot;

  const saveProvider = async (provider: ProviderConfig) => {
    setDraft((d) => {
      const exists = d.providers.some((p) => p.id === provider.id);
      const providers = exists
        ? d.providers.map((p) => (p.id === provider.id ? provider : p))
        : [...d.providers, provider];
      return { ...d, providers };
    });
  };

  const removeProvider = (p: ProviderConfig) => {
    if (!window.confirm(`确定删除提供商「${p.name}」吗？`)) return;
    setDraft((d) => ({
      ...d,
      providers: d.providers.filter((x) => x.id !== p.id),
    }));
  };

  const requestClose = () => {
    if (saving) return;
    if (dirty && !window.confirm('有未保存的更改，确定放弃并关闭吗？')) return;
    onClose();
  };

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError('');
    try {
      await onSave({
        ...draft,
        commandApproval: draft.commandApproval ?? 'ask',
        fileApproval: draft.fileApproval ?? 'ask',
        databaseApproval: draft.databaseApproval ?? 'ask',
        mcpServers: draft.mcpServers ?? [],
      });
      onClose();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // 快捷键：Esc 关闭、Ctrl/Cmd+S 保存；子弹窗打开时不拦截
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (editing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      requestClose();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className="modal wide settings-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">
          <span>设置</span>
          <button
            type="button"
            className="modal-close"
            onClick={requestClose}
            aria-label="关闭"
            title="关闭 (Esc)"
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
                + 添加提供商
              </button>
            </div>

            {draft.providers.length === 0 ? (
              <div className="muted small">
                还没有提供商，点击右上角「添加提供商」开始配置
              </div>
            ) : (
              <ul className="provider-list">
                {draft.providers.map((p) => {
                  const hasKey = status.find((s) => s.id === p.id)?.hasKey;
                  const meta = [
                    p.baseUrl,
                    p.apiKeyEnv,
                    `${p.models.length} 个模型`,
                  ]
                    .filter((s) => typeof s === 'string' && s.trim())
                    .join(' · ');
                  return (
                    <li key={p.id}>
                      <div className="provider-info">
                        <div className="provider-name">
                          {p.name}{' '}
                          <span className="muted small">{p.id}</span>{' '}
                          <span
                            className={`approval-state ${hasKey ? 'is-ask' : 'is-auto'}`}
                          >
                            {hasKey ? 'Key 已配置' : 'Key 未配置'}
                          </span>
                        </div>
                        <div className="muted small" title={meta}>
                          {meta}
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
                          onClick={() => removeProvider(p)}
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
              API Key 可以直接填写（保存在本地配置），也可以只填环境变量名，从
              <code> apps/editor-desktop/.env </code>
              读取（修改后要重启）。没有 Key 的提供商不会出现在模型选择里。默认只内置免费模型
              <code> {DEFAULT_MODEL_ID} </code>，需要其他模型请自行添加。
            </p>
          </section>

          <section className="settings-section">
            <div className="section-head">
              <h4>工具审批</h4>
            </div>
            <p className="hint">
              <strong>开 = 每次询问</strong>，<strong>关 = 自动放行</strong>。只读操作始终不询问。
            </p>
            <ApprovalToggle
              title="命令执行"
              description="run_terminal / http_request / MCP 工具"
              value={draft.commandApproval}
              onChange={(v) => setDraft((d) => ({ ...d, commandApproval: v }))}
            />
            <ApprovalToggle
              title="文件写操作"
              description="开启后先生成 diff，可逐块接受或拒绝"
              value={draft.fileApproval}
              onChange={(v) => setDraft((d) => ({ ...d, fileApproval: v }))}
            />
            <ApprovalToggle
              title="数据库写操作"
              description="execute_sql 写入前确认"
              value={draft.databaseApproval}
              onChange={(v) => setDraft((d) => ({ ...d, databaseApproval: v }))}
            />
          </section>

          <McpSettings
            servers={draft.mcpServers ?? []}
            onChange={(mcpServers) => setDraft((d) => ({ ...d, mcpServers }))}
          />

          <DatabaseSettings />

          {error ? <div className="modal-error">⚠️ {error}</div> : null}
        </div>
        <div className="modal-actions">
          <span className="muted small" style={{ marginRight: 'auto' }}>
            {dirty ? '有未保存的更改' : ''}
          </span>
          <button className="ghost" onClick={requestClose} disabled={saving}>
            取消
          </button>
          <button
            className="settings-save"
            onClick={() => void save()}
            disabled={saving || !dirty}
            title={dirty ? '保存 (Ctrl+S)' : '没有需要保存的更改'}
          >
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
 * 当前状态通过悬停提示和 aria-label 给出，不再在开关旁重复显示文字。
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
  const stateText = ask
    ? '当前：每次询问（点击改为自动放行）'
    : '当前：自动放行（点击改为每次询问）';
  return (
    <div className="approval-row">
      <div className="approval-row-text">
        <strong>{title}</strong>
        <span className="muted small">{description}</span>
      </div>
      <div className="approval-row-control">
        <label className="switch" title={stateText}>
          <input
            type="checkbox"
            checked={ask}
            aria-label={`${title}：${stateText}`}
            onChange={(e) => onChange(e.target.checked ? 'ask' : 'auto')}
          />
          <span className="switch-slider" />
        </label>
      </div>
    </div>
  );
}
