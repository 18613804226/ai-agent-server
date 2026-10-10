import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatWebSearchContext,
  isLiveInfoQuery,
  searchTavily,
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
  ])('识别实时查询：%s', (query) => {
    expect(isLiveInfoQuery(query)).toBe(true);
  });

  it.each(['你好', '解释一下向量数据库', '帮我总结这段文字'])(
    '不将一般查询识别为实时查询：%s',
    (query) => {
      expect(isLiveInfoQuery(query)).toBe(false);
    },
  );
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
        query: expect.stringContaining('搜索微博热搜 TOP10'),
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
