import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatIndexedWebSearchContext,
  formatWebSearchContext,
  isEmotionalTurn,
  isLiveInfoQuery,
  searchBocha,
  searchTavily,
  searchWeb,
  webSearchProvider,
  type WebSearchResult,
} from './web-search.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('isLiveInfoQuery', () => {
  it.each([
    '搜索微博 TOP10 热度的话题',
    '今天的新闻',
    '最新美元汇率',
    '现在的股价',
    '搜索李二毛',
    '查一下这个人',
    '帮我查一下',
    '李二毛',
    '特朗普',
    'iPhone 16',
    '《三体》',
    // 验收：明确检索任务、情绪句里夹任务、时间词 + 查询动作
    '帮我查下 XX 公司校招开了没',
    '面试不顺，帮我查下这家公司',
    '现在几点',
    '今天有啥新闻',
    // 强时效事件词：没有「新闻」二字也该触发联网检索
    '哪吒什么时候上映',
    '新剧今晚几点开播',
    '中国队夺冠了吗',
    '今晚双色球开奖结果',
    '腾讯第三季度财报',
  ])('识别实时查询：%s', (query) => {
    expect(isLiveInfoQuery(query)).toBe(true);
  });

  it.each([
    '你好',
    '解释一下向量数据库',
    '帮我总结这段文字',
    '你是谁',
    '谢谢',
    '再见',
    '帮我写一首诗',
    '今天天气怎么样',
    '好吧',
    '好吧。',
    '行吧',
    '嗯嗯',
    '好嘞',
    '哈哈哈',
    '嘻嘻',
    '嘻嘻哈哈',
    '笑嘻嘻',
    '好不好',
    // 验收：倾诉、收尾、叙述句，以及「今天/最近/现在」不再单独当成检索信号
    '今天面试不太顺',
    '算了不聊这个了',
    '今天看了个电影',
    '最近怎么样',
    '最近心情很差',
    '今天好累',
    '现在很难受',
    '难过',
    '查一下我该怎么办',
  ])('不将一般查询识别为实时查询：%s', (query) => {
    expect(isLiveInfoQuery(query)).toBe(false);
  });
});

describe('isEmotionalTurn', () => {
  it.each([
    '今天面试不太顺',
    '算了不聊这个了',
    '最近心情很差',
    '查一下我该怎么办',
  ])('识别纯倾诉/求助：%s', (query) => {
    expect(isEmotionalTurn(query)).toBe(true);
  });

  it.each([
    '帮我查下 XX 公司校招开了没',
    '面试不顺，帮我查下这家公司',
    '今天的新闻',
  ])('夹带明确任务或纯事实查询时不算倾诉：%s', (query) => {
    expect(isEmotionalTurn(query)).toBe(false);
  });
});

describe('formatWebSearchContext', () => {
  it('为模型上下文保留标题、可点击来源、日期和摘要', () => {
    const results: WebSearchResult[] = [
      {
        title: '微博热搜榜',
        url: 'https://example.com/trending',
        publishedDate: '2026-10-10',
        content: '当前热门话题列表',
      },
    ];

    expect(formatWebSearchContext(results)).toContain(
      '[1] 微博热搜榜\nURL: https://example.com/trending\n' +
        '发布时间: 2026-10-10\n摘要: 当前热门话题列表',
    );
  });

  it('formatIndexedWebSearchContext 使用调用方给定的全局编号', () => {
    const result: WebSearchResult = {
      title: '新闻C',
      url: 'https://c.com/3',
      content: '摘要C',
    };

    expect(
      formatIndexedWebSearchContext([{ ...result, index: 3 }]),
    ).toContain(
      '[3] 新闻C\nURL: https://c.com/3\n发布时间: 来源未提供\n摘要: 摘要C',
    );
  });

  it('两者文案完全一致：formatWebSearchContext 只是从 1 编号的便捷包装', () => {
    const results: WebSearchResult[] = [
      { title: '新闻A', url: 'https://a.com/1', content: '摘要A' },
    ];

    expect(formatWebSearchContext(results)).toBe(
      formatIndexedWebSearchContext([{ ...results[0], index: 1 }]),
    );
  });

  it('格式化结果只含数据，不夹带内部指令（避免模型复述）', () => {
    const results: WebSearchResult[] = [
      { title: '新闻A', url: 'https://a.com/1', content: '摘要A' },
    ];

    const text = formatWebSearchContext(results);
    expect(text).toContain('[1] 新闻A');
    expect(text).toContain('URL: https://a.com/1');
    expect(text).not.toContain('引用请用');
    expect(text).not.toContain('禁止把裸 URL');
    expect(text).not.toContain('URL 仅用于生成来源链接');
  });
});

describe('searchTavily', () => {
  it('将用户查询发给 Tavily，并过滤无效来源、最多保留十条', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    const results = Array.from({ length: 11 }, (_, index) => ({
      title: `来源 ${index + 1}`,
      url: `https://example.com/${index + 1}`,
      content: `摘要 ${index + 1}`,
    }));
    results.push({
      title: '无效协议',
      url: 'javascript:alert(1)',
      content: '不应作为来源',
    });
    const response: AxiosResponse = {
      data: { results },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
    const post = vi.spyOn(axios, 'post').mockResolvedValue(response);

    const found = await searchTavily('搜索微博热搜 TOP10');

    expect(post).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        api_key: 'test-key',
        // 精确匹配：检索词不能再被拼上当天 ISO 日期
        query: '搜索微博热搜 TOP10',
        search_depth: 'advanced',
        max_results: 10,
      }),
      expect.objectContaining({ timeout: 15000 }),
    );
    expect(found).toHaveLength(10);
    expect(found.some((result) => result.url.startsWith('javascript:'))).toBe(
      false,
    );
  });

  it('缺少 API Key 时明确报出配置要求', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');

    await expect(searchTavily('搜索微博热搜')).rejects.toThrow(
      '请在后端环境变量中设置 TAVILY_API_KEY',
    );
  });
});

function mockResponse(data: unknown): AxiosResponse {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

describe('provider 选择', () => {
  it.each([
    ['', 'tavily'],
    ['tavily', 'tavily'],
    ['TAVILY', 'tavily'],
    ['bocha', 'bocha'],
    ['BOCHA', 'bocha'],
    ['写错了', 'tavily'],
  ] as const)('WEB_SEARCH_PROVIDER=%s → %s', (value, expected) => {
    vi.stubEnv('WEB_SEARCH_PROVIDER', value);
    expect(webSearchProvider()).toBe(expected);
  });
});

describe('searchBocha（国内 adapter）', () => {
  it('按官方接口请求，并把 webPages.value 归一化成统一契约', async () => {
    vi.stubEnv('BOCHA_API_KEY', 'bocha-key');
    const post = vi.spyOn(axios, 'post').mockResolvedValue(
      mockResponse({
        webPages: {
          value: [
            {
              name: ' 微博热搜榜 ',
              url: 'https://weibo.com/hot',
              summary: '今日热点 '.repeat(100),
              snippet: '短摘要',
              datePublished: '2026-11-09T00:00:00+08:00',
            },
            {
              name: '仅短摘要',
              url: 'https://example.com/a',
              snippet: '兜底摘要',
            },
            { name: '坏协议', url: 'javascript:alert(1)', snippet: '不该出现' },
            { name: '缺 URL', snippet: '不该出现' },
          ],
        },
      }),
    );

    const found = await searchBocha('今天的新闻');

    expect(post).toHaveBeenCalledWith(
      'https://api.bochaai.com/v1/web-search',
      expect.objectContaining({
        // 精确匹配：日期不进检索词，时效由 freshness 控制
        query: '今天的新闻',
        freshness: 'noLimit',
        summary: true,
        count: 10,
      }),
      expect.objectContaining({
        timeout: 15000,
        headers: expect.objectContaining({
          Authorization: 'Bearer bocha-key',
        }),
      }),
    );
    expect(found).toHaveLength(2);
    expect(found[0].title).toBe('微博热搜榜');
    expect(found[0].content.length).toBeLessThanOrEqual(400);
    expect(found[0].publishedDate).toBe('2026-11-09T00:00:00+08:00');
    expect(found[1].content).toBe('兜底摘要');
    expect(found.some((result) => result.url.startsWith('javascript:'))).toBe(
      false,
    );
  });

  it('缺 key 明确报错；BOCHA_API_URL 可覆盖 endpoint', async () => {
    vi.stubEnv('BOCHA_API_KEY', '');
    await expect(searchBocha('新闻')).rejects.toThrow('BOCHA_API_KEY');

    vi.stubEnv('BOCHA_API_KEY', 'bocha-key');
    vi.stubEnv('BOCHA_API_URL', 'https://proxy.internal/v1/web-search');
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue(mockResponse({ webPages: { value: [] } }));
    await searchBocha('新闻');
    expect(post).toHaveBeenCalledWith(
      'https://proxy.internal/v1/web-search',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('searchWeb：分发 + 打点', () => {
  it('默认走 Tavily，成功日志只含 provider/结果数/耗时', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('TAVILY_API_KEY', 'tavily-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    const post = vi.spyOn(axios, 'post').mockResolvedValue(
      mockResponse({
        results: [
          { title: '标题', url: 'https://example.com/a', content: '摘要' },
        ],
      }),
    );

    const found = await searchWeb('查一下机密关键词');

    expect(post).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.anything(),
      expect.anything(),
    );
    expect(found).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('"provider":"tavily"');
    expect(line).toContain('"ok":true');
    expect(line).toContain('"results":1');
    expect(line).toContain('"durationMs"');
    // 用户查询与凭据不能进日志
    expect(line).not.toContain('机密关键词');
    expect(line).not.toContain('tavily-key');
  });

  it('WEB_SEARCH_PROVIDER=bocha 时分发到博查', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'bocha');
    vi.stubEnv('BOCHA_API_KEY', 'bocha-key');
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue(mockResponse({ webPages: { value: [] } }));

    await searchWeb('新闻');

    expect(post).toHaveBeenCalledWith(
      'https://api.bochaai.com/v1/web-search',
      expect.anything(),
      expect.anything(),
    );
  });

  it('失败打 warn 日志并抛出，交给上层降级（不打 query）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.spyOn(axios, 'post').mockResolvedValue(mockResponse({}));

    await expect(searchWeb('今天的新闻')).rejects.toThrow('TAVILY_API_KEY');

    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('"ok":false');
    expect(line).toContain('"durationMs"');
    expect(line).not.toContain('今天的新闻');
  });

  it('WEB_SEARCH_TIMEOUT_MS 可配，越界回落 15000', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'k');
    vi.stubEnv('WEB_SEARCH_TIMEOUT_MS', '8000');
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue(mockResponse({ results: [] }));

    await searchTavily('新闻');
    expect(post).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeout: 8000 }),
    );

    vi.stubEnv('WEB_SEARCH_TIMEOUT_MS', '999999');
    await searchTavily('新闻');
    expect(post).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeout: 15000 }),
    );
  });
});
