import OpenAI from 'openai';
import { resolveZhipuCredentials } from '@repo/agent-orchestrator';

export type ModelProvider = 'zhipu' | 'dashscope' | 'modelscope';

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
    /** 未配置 MODELSCOPE_API_KEY 时为 null，首选候选会被跳过 */
    public modelscope: OpenAI | null = null,
  ) {}

  getClient(provider: ModelProvider): OpenAI | null {
    if (provider === 'zhipu') return this.zhipu;
    if (provider === 'modelscope') return this.modelscope;
    return this.dashscope;
  }
}

/** 从环境变量构造默认客户端（未配置 key 的 provider 为 null，候选自动跳过） */
export function createDefaultModelClients(): ModelClients {
  const dashscope = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_BASE_URL || '',
  });
  const zhipuCreds = resolveZhipuCredentials();
  const zhipu = zhipuCreds
    ? new OpenAI({ apiKey: zhipuCreds.apiKey, baseURL: zhipuCreds.baseURL })
    : null;
  const msKey = process.env.MODELSCOPE_API_KEY?.trim();
  const modelscope = msKey
    ? new OpenAI({
        apiKey: msKey,
        baseURL:
          process.env.MODELSCOPE_BASE_URL?.trim() ||
          'https://api-inference.modelscope.cn/v1',
      })
    : null;
  return new ModelClients(dashscope, zhipu, modelscope);
}
