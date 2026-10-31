import OpenAI from 'openai';
import { resolveZhipuCredentials } from '@repo/agent-orchestrator';

export type ModelProvider = 'zhipu' | 'dashscope';

/**
 * 模型客户端持有器。
 *
 * 用「实例 + getClient」而不是直接传客户端，是为了让测试能替换 mock 客户端，
 * 同时让整个进程共享同一套客户端（进而共享同一把智谱并发锁）。
 */
export class ModelClients {
  constructor(
    public dashscope: OpenAI,
    public zhipu: OpenAI | null,
  ) {}

  getClient(provider: ModelProvider): OpenAI | null {
    return provider === 'zhipu' ? this.zhipu : this.dashscope;
  }
}

/** 从环境变量构造默认客户端（未配置 GLM key 时 zhipu 为 null，自动退化为单模型） */
export function createDefaultModelClients(): ModelClients {
  const dashscope = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_BASE_URL || '',
  });
  const zhipuCreds = resolveZhipuCredentials();
  const zhipu = zhipuCreds
    ? new OpenAI({ apiKey: zhipuCreds.apiKey, baseURL: zhipuCreds.baseURL })
    : null;
  return new ModelClients(dashscope, zhipu);
}
