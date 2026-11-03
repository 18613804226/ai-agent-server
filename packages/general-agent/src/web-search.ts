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

export const isLiveInfoQuery = (query: string): boolean => {
  const trimmed = query.trim();
  // 天气查询由 fetchWeatherInfo 处理，不走 Tavily
  if (/天气/.test(trimmed)) return false;
  // 显式关键词命中
  if (
    /实时|现在|当前|今天|今日|最新|近期|最近|热搜|热榜|热点|热度|新闻|榜单|排行榜|微博|股价|汇率|搜索|搜一下|搜搜|帮我搜|查一下|查查|查询|帮我查|top\s*\d+/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  // 短查询兜底：默认不搜，只有「像实体/术语」的短输入才按实时查询处理。
  // 正向信号：含数字/字母/书名号（型号、榜单、作品名），或 2-6 个汉字。
  // 反向过滤：命中问候/确认/请求句式，或含句法成分（语气词、代词、疑问词、能愿动词等），
  //          说明它是一句话而不是一个词，交给普通对话/工具链处理。
  // 这样「好吧」「行吧」「哈哈哈」不会被当成搜索，而「特朗普」「李二毛」「iPhone 16」仍会命中。
  if (trimmed.length > 0 && trimmed.length <= 20) {
    const looksLikeEntity =
      /[0-9A-Za-z]/.test(trimmed) ||
      /[《「『“《]/.test(trimmed) ||
      /^[\u4e00-\u9fa5]{2,6}[。.!！?？]?$/.test(trimmed);
    if (!looksLikeEntity) return false;
    const isUtterance =
      /^(你好|您好|hi|hello|早上好|晚上好|下午好|谢谢|再见|拜拜|好的|好吧|好嘞|好滴|行吧|行啊|嗯嗯|嗯啊|是的|不是|嗯|啊|哦|你是)/i.test(
        trimmed,
      ) ||
      /怎么|为什么|如何|是什么|什么是|解释|吗$|呢$|？|\?|天气/.test(trimmed) ||
      /^(帮我|请|麻烦|能否|可以|给我|帮我写|帮我做|帮我总结)/.test(trimmed) ||
      /的|了|吗|呢|吧|啊|嗯|哦|啦|呀|嘛|呗|哇|哈|嘞|咯|是|在|有|我|你|他|她|它|们|这|那|哪|谁|什么|怎么|为什么|如何|多少|几|个|一下|请问|告诉|介绍|认为|觉得|知道|想|要|会|能|可以|帮|请/.test(
        trimmed,
      );
    if (!isUtterance) return true;
  }
  return false;
};

export async function searchTavily(
  query: string,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('实时搜索未配置：请在后端环境变量中设置 TAVILY_API_KEY。');
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
    throw new Error('实时搜索服务暂时不可用，请稍后重试。');
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
