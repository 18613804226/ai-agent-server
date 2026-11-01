import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { ModelConfig } from '../shared/providers.js';

export type { ModelConfig };

export interface ProviderConfig {
  id: string;
  name: string;
  /** 预设 id（openai / deepseek / zhipu / ollama ...），仅作标识 */
  api: string;
  baseUrl: string;
  /** 从哪个环境变量读 API Key（不把 key 存进配置文件） */
  apiKeyEnv: string;
  /** false = 本地服务，不需要 key（如 Ollama） */
  requiresKey?: boolean;
  models: ModelConfig[];
}

export type ApprovalMode = 'ask' | 'auto';

export interface AppConfig {
  providers: ProviderConfig[];
  /** 本地模式选中的模型 id */
  selectedModel: string;
  /** 工具审批：always 询问 / auto 自动放行 */
  approvalMode: ApprovalMode;
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
 */
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'glm',
    name: '智谱 GLM（免费）',
    api: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'GLM_API_KEY',
    models: [
      { id: 'glm-4.5-flash', name: 'GLM-4.5-Flash（免费）' },
      { id: 'glm-4-flash', name: 'GLM-4-Flash（免费）' },
      { id: 'glm-4-flash-250414', name: 'GLM-4-Flash-250414（免费）' },
    ],
  },
];

const DEFAULTS: AppConfig = {
  providers: DEFAULT_PROVIDERS,
  selectedModel: 'glm-4.5-flash',
  approvalMode: 'ask',
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
      approvalMode: raw.approvalMode === 'auto' ? 'auto' : 'ask',
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
