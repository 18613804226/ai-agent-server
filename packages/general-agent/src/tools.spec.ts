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

describe('fetchWeatherInfo（Open-Meteo）', () => {
  // 城市名各用一次：coordsCache 是模块级缓存，避免用例之间串坐标
  const geo = (name: string, latitude: number, longitude: number) =>
    ({
      data: { results: [{ name, latitude, longitude }] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: {} },
    }) as never;

  const forecast = (current: unknown) =>
    ({
      data: { current },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: {} },
    }) as never;

  const current = (
    temperature_2m: number,
    relative_humidity_2m: number,
    weather_code: number,
  ) => ({ temperature_2m, relative_humidity_2m, weather_code });

  const call = (cityName: string) => {
    const tool = createGeneralTools().find(
      (item) => item.definition.function.name === 'fetchWeatherInfo',
    )!;
    return tool.handler({ cityName }, { toolName: 'fetchWeatherInfo' });
  };

  it('中文城市名经 geocoding 拿坐标，输出中文天气描述与数值', async () => {
    const spy = vi.spyOn(axios, 'get');
    spy.mockResolvedValueOnce(geo('北京', 39.9, 116.4));
    spy.mockResolvedValueOnce(forecast(current(2.7, 98, 45)));

    const text = await call('北京');

    expect(text).toContain('2.7℃');
    expect(text).toContain('天气状况：雾');
    expect(text).toContain('湿度：98%');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][1]?.params).toMatchObject({
      name: '北京',
      count: 1,
      language: 'zh',
    });
    expect(spy.mock.calls[1][1]?.params).toMatchObject({
      latitude: 39.9,
      longitude: 116.4,
      timezone: 'auto',
    });
    expect(spy.mock.calls[1][1]?.timeout).toBe(5000);
  });

  it('geocoding 无结果：返回明确的「查不到」，不带播报前缀', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: { results: [] },
    } as never);

    const text = await call('查无此城XYZ');

    expect(text).toContain('天气查询不可用');
    expect(text).toContain('不要编造');
    expect(text).not.toContain('【实时天气播报】');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('forecast 字段缺失：不会把 undefined 播出去，直接降级', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(axios, 'get');
    spy.mockResolvedValueOnce(geo('上海', 31.2, 121.5));
    spy.mockResolvedValueOnce(forecast({ temperature_2m: null }));

    const text = await call('上海');

    expect(text).toContain('天气查询不可用');
    expect(text).not.toContain('undefined');
  });

  it('任一跳超时：返回降级文案，不抛错打断工具循环', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockRejectedValueOnce(new Error('timeout'));

    await expect(call('广州')).resolves.toContain('天气查询不可用');
  });

  it('未知 WMO 码有兜底，超时读 WEATHER_TIMEOUT_MS', async () => {
    vi.stubEnv('WEATHER_TIMEOUT_MS', '8000');
    const spy = vi.spyOn(axios, 'get');
    spy.mockResolvedValueOnce(geo('深圳', 22.5, 114.1));
    spy.mockResolvedValueOnce(forecast(current(26, 70, 999)));

    const text = await call('深圳');

    expect(text).toContain('未识别天气（WMO 999）');
    expect(spy.mock.calls[0][1]?.timeout).toBe(8000);
  });

  it('同一城市第二次复用坐标，不再请求 geocoding', async () => {
    const spy = vi.spyOn(axios, 'get');
    spy.mockResolvedValueOnce(geo('杭州', 30.3, 120.2));
    spy.mockResolvedValueOnce(forecast(current(18, 60, 0)));
    spy.mockResolvedValueOnce(forecast(current(19, 61, 1)));

    await call('杭州');
    const text = await call('杭州');

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[2][0]).toContain('api.open-meteo.com');
    expect(text).toContain('19℃');
    expect(text).toContain('晴间多云');
  });
});
