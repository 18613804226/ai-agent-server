import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  PROVIDER_PRESETS,
  type ModelConfig,
} from '../shared/providers.js';

export type { ModelConfig };

export interface ProviderConfig {
  id: string;
  name: string;
  /** 预设 id（openai / deepseek / zhipu / ollama ...），仅作标识 */
  api: string;
  baseUrl: string;
  /** 从哪个环境变量读 API Key（apiKey 为空时回退） */
  apiKeyEnv: string;
  /** 直接配置的 API Key，优先于环境变量；会保存到本地配置文件 */
  apiKey?: string;
  /** false = 本地服务，不需要 key（如 Ollama） */
  requiresKey?: boolean;
  models: ModelConfig[];
}

export type ApprovalMode = 'ask' | 'auto';

export interface AppConfig {
  providers: ProviderConfig[];
  /** 本地模式选中的模型 id */
  selectedModel: string;
  /** @deprecated 用 commandApproval / fileApproval 代替 */
  approvalMode?: ApprovalMode;
  /** 命令执行审批：ask 询问 / auto 自动放行 */
  commandApproval: ApprovalMode;
  /** 文件操作审批（写/删/移动）：ask 询问 / auto 自动放行 */
  fileApproval: ApprovalMode;
  /** 数据库写操作审批（execute_sql）：ask 询问 / auto 自动放行 */
  databaseApproval: ApprovalMode;
  local: {
    /** 上次打开的多个工作区文件夹（下次启动恢复） */
    workspaceRoots?: string[];
  };
  remote: {
    /** 云端模式覆盖模型；空串 = 用后端级联 */
    model?: string;
  };
}

/**
 * 内置提供商：没添加自定义提供商时只显示一个免费模型。
 * 更多模型/提供商在「设置 → 提供商」里自行添加。
 *
 * 直接从 PROVIDER_PRESETS 派生，避免和预设各写一份模型列表（改一处即可）。
 */
export const DEFAULT_PROVIDERS: ProviderConfig[] = PROVIDER_PRESETS.filter(
  (p) => p.id === DEFAULT_PROVIDER_ID,
).map((p) => ({
  id: p.id,
  name: p.label,
  api: p.id,
  baseUrl: p.baseUrl,
  apiKeyEnv: p.apiKeyEnv,
  requiresKey: p.requiresKey,
  models: p.models,
}));

const DEFAULTS: AppConfig = {
  providers: DEFAULT_PROVIDERS,
  selectedModel: DEFAULT_MODEL_ID,
  commandApproval: 'ask',
  fileApproval: 'ask',
  databaseApproval: 'ask',
  local: { workspaceRoots: [] },
  remote: { model: '' },
};

let cache: AppConfig | null = null;

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

export function getConfig(): AppConfig {
  if (cache) return cache;
  if (!existsSync(configPath())) {
    cache = structuredClone(DEFAULTS);
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    cache = {
      providers:
        Array.isArray(raw.providers) && raw.providers.length
          ? raw.providers
          : structuredClone(DEFAULT_PROVIDERS),
      selectedModel:
        typeof raw.selectedModel === 'string'
          ? raw.selectedModel
          : DEFAULTS.selectedModel,
      // 兼容旧配置：approvalMode 迁移到 commandApproval/fileApproval
      commandApproval:
        raw.commandApproval === 'auto' ||
        (!raw.commandApproval && raw.approvalMode === 'auto')
          ? 'auto'
          : 'ask',
      fileApproval:
        raw.fileApproval === 'auto' ||
        (!raw.fileApproval && raw.approvalMode === 'auto')
          ? 'auto'
          : 'ask',
      databaseApproval:
        raw.databaseApproval === 'auto' ? 'auto' : 'ask',
      local: {
        workspaceRoots: Array.isArray(raw.local?.workspaceRoots)
          ? raw.local.workspaceRoots
          : raw.local?.workspaceRoot
            ? [raw.local.workspaceRoot]
            : [],
      },
      remote: { model: raw.remote?.model || '' },
    };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

export function setConfig(next: AppConfig): AppConfig {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  cache = next;
  return next;
}
