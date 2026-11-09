import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
import axios from 'axios';
import { generalAgent } from './agent.js';
import { createChatTools, createGeneralTools } from './tools.js';
import { SearchSession } from './search-session.js';

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

describe('web_search 结果回流本轮来源池', () => {
  const results = [
    { title: '新闻A', url: 'https://a.com/1', content: '摘要A' },
    { title: '新闻B', url: 'https://b.com/2', content: '摘要B' },
  ];

  function mockSearch() {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    return vi.spyOn(axios, 'post').mockResolvedValue({
      data: { results },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: {} },
    } as never);
  }

  it('传入 session 时结果同时登记来源，提示词沿用全局编号', async () => {
    mockSearch();
    const session = new SearchSession();
    session.add(
      [{ title: '旧来源', url: 'https://old.com/0', content: '旧摘要' }],
      { origin: 'prefetch', query: 'q0' },
    );
    const tool = createChatTools(session).find(
      (item) => item.definition.function.name === 'web_search',
    )!;

    const text = await tool.handler({ query: 'q1' }, { toolName: 'web_search' });

    expect(session.list()).toHaveLength(3);
    expect(session.list().map((source) => source.index)).toEqual([1, 2, 3]);
    expect(text).toContain('[2] 新闻A');
    expect(text).toContain('[3] 新闻B');
  });

  it('不传 session 时行为与改造前一致：编号从 1 开始', async () => {
    mockSearch();
    const tool = createChatTools().find(
      (item) => item.definition.function.name === 'web_search',
    )!;

    const text = await tool.handler({ query: 'q1' }, { toolName: 'web_search' });

    expect(text).toContain('[1] 新闻A');
    expect(text).toContain('[2] 新闻B');
    // 引用规则已挪进 system prompt，工具结果里不能再夹带指令让模型复述
    expect(text).not.toContain('引用请用');
    expect(text).not.toContain('禁止把裸 URL');
  });

  it('联网失败仍返回降级文案，且不往 session 写来源', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    vi.stubEnv('TAVILY_API_KEY', '');
    const session = new SearchSession();
    const tool = createChatTools(session).find(
      (item) => item.definition.function.name === 'web_search',
    )!;

    const text = await tool.handler({ query: 'q' }, { toolName: 'web_search' });

    expect(text).toContain('联网检索暂不可用');
    expect(session.size).toBe(0);
  });
});
