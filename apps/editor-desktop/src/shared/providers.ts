/**
 * 提供商预设：全部走 OpenAI 兼容协议，选中后自动填 baseUrl / key 环境变量 / 默认模型。
 * 主进程和渲染进程共用。
 */

export interface ModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  vision?: boolean;
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  /** false = 本地服务，不需要 key（如 Ollama） */
  requiresKey?: boolean;
  models: ModelConfig[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      { id: 'gpt-4o', name: 'GPT-4o' },
    ],
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI Compatible（自定义）',
    baseUrl: '',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: true },
    ],
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    models: [{ id: 'moonshot-v1-8k', name: 'Moonshot v1 8k' }],
  },
  {
    id: 'qwen',
    label: '通义千问 (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [
      { id: 'qwen3.7-flash', name: 'Qwen3.7-Flash' },
      {
        id: 'qwen3.8-max-0902',
        name: 'Qwen3.8-Max',
        reasoning: true,
        vision: true,
      },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'GLM_API_KEY',
    models: [
      { id: 'glm-4.5-flash', name: 'GLM-4.5-Flash（免费）' },
      { id: 'glm-4-flash', name: 'GLM-4-Flash（免费）' },
      { id: 'glm-4-flash-250414', name: 'GLM-4-Flash-250414（免费）' },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    requiresKey: false,
    models: [{ id: 'llama3.1', name: 'Llama 3.1' }],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: [],
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    models: [],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    models: [],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    models: [],
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    models: [],
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    baseUrl:
      'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT',
    apiKeyEnv: 'AZURE_OPENAI_API_KEY',
    models: [],
  },
];
