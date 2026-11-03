import OpenAI from 'openai';
import type { ModelConfig, ProviderConfig } from '../config.js';

export interface ResolvedModel {
  provider: ProviderConfig;
  model: ModelConfig;
  client: OpenAI;
}

/** 判断某个提供商是否配置了 key（本地服务可不需要 key） */
export function providerHasKey(provider: ProviderConfig): boolean {
  return (
    provider.requiresKey === false ||
    Boolean(provider.apiKey?.trim()) ||
    Boolean(process.env[provider.apiKeyEnv])
  );
}

/**
 * 把模型 id 解析成「提供商 + 模型 + OpenAI 客户端」。
 * key 从 provider.apiKeyEnv 指向的环境变量读取，不落配置文件。
 */
export function resolveModel(
  providers: ProviderConfig[],
  modelId: string,
): ResolvedModel {
  const provider = providers.find((p) =>
    p.models.some((m) => m.id === modelId),
  );
  if (!provider) {
    throw new Error(`未找到模型 ${modelId} 对应的提供商`);
  }
  const model = provider.models.find((m) => m.id === modelId)!;
  const apiKey =
    provider.apiKey?.trim() ||
    process.env[provider.apiKeyEnv] ||
    (provider.requiresKey === false ? 'no-key' : '');
  if (!apiKey) {
    throw new Error(
      `未配置环境变量 ${provider.apiKeyEnv}，请在 apps/editor-desktop/.env 中配置后重启应用`,
    );
  }
  return {
    provider,
    model,
    client: new OpenAI({ apiKey, baseURL: provider.baseUrl }),
  };
}
