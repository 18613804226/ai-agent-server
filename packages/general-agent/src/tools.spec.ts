import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
import { generalAgent } from './agent.js';
import { createChatTools, createGeneralTools } from './tools.js';

const names = (tools: ReturnType<typeof createChatTools>) =>
  tools.map((tool) => tool.definition.function.name);

describe('general-agent 工具集', () => {
  it('general 包含联网搜索 + 天气/计算/农历节日', () => {
    expect(names(createGeneralTools())).toEqual([
      'fetchWeatherInfo',
      'calculator',
      'web_search',
      'festival_info',
    ]);
  });

  it('chat 也暴露 web_search：后端关键词没命中时模型可自己搜', () => {
    expect(names(createChatTools())).toEqual([
      'fetchWeatherInfo',
      'calculator',
      'web_search',
      'festival_info',
    ]);
  });

  it('generalAgent 直接复用同一套工具与 prompt', () => {
    expect(generalAgent.id).toBe('general');
    expect(generalAgent.tools).toEqual(createGeneralTools());
    expect(generalAgent.buildSystemPrompt({ query: '几号是春节' })).toContain(
      'festival_info',
    );
  });

  it('web_search 联网失败不抛错，返回「无可引用资料」说明让模型如实回答', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    vi.stubEnv('TAVILY_API_KEY', '');
    const tool = createGeneralTools().find(
      (item) => item.definition.function.name === 'web_search',
    )!;

    const result = await tool.handler(
      { query: '今天的新闻' },
      { toolName: 'web_search' },
    );

    expect(result).toContain('联网检索暂不可用');
    expect(result).toContain('不要编造');
  });
});
