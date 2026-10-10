import { HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
}

interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string | null;
  }>;
}

export const isLiveInfoQuery = (query: string): boolean =>
  /实时|现在|当前|今天|今日|最新|近期|最近|热搜|热榜|热点|热度|新闻|榜单|排行榜|微博|股价|汇率|top\s*\d+/i.test(
    query,
  );

export async function searchTavily(
  query: string,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new HttpException(
      '实时搜索未配置：请在后端环境变量中设置 TAVILY_API_KEY。',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  let data: TavilySearchResponse;
  try {
    const response = await axios.post<TavilySearchResponse>(
      'https://api.tavily.com/search',
      {
        api_key: apiKey,
        query: `${query} ${date}`,
        topic: 'general',
        search_depth: 'advanced',
        max_results: 10,
        include_answer: false,
        include_raw_content: false,
      },
      { timeout: 15000, signal },
    );
    data = response.data;
  } catch (error) {
    if (signal?.aborted) throw error;
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;
    const code = axios.isAxiosError(error) ? error.code : undefined;
    console.error('Tavily 联网搜索请求失败:', { status, code });
    throw new HttpException(
      '实时搜索服务暂时不可用，请稍后重试。',
      HttpStatus.BAD_GATEWAY,
    );
  }

  return (Array.isArray(data.results) ? data.results : [])
    .flatMap((result) => {
      if (!result.title || !result.url || !result.content) return [];
      try {
        const url = new URL(result.url);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
      } catch {
        return [];
      }
      return [
        {
          title: result.title.trim(),
          url: result.url,
          content: result.content.replace(/\s+/g, ' ').trim().slice(0, 400),
          ...(result.published_date
            ? { publishedDate: result.published_date }
            : {}),
        },
      ];
    })
    .slice(0, 10);
}

export function formatWebSearchContext(results: WebSearchResult[]): string {
  return results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title}\nURL: ${result.url}\n` +
        `发布时间: ${result.publishedDate || '来源未提供'}\n摘要: ${result.content}`,
    )
    .join('\n\n');
}
