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

/** 情绪倾诉 / 收尾：这类句子不联网、不查资料，交给普通对话处理 */
const EMOTIONAL_TALK =
  /^(算了|不聊|不想|罢了|哎|唉|嗯|哦|好吧|行吧)|不聊了|不说了|心累|好累|好烦|难受|难过|沮丧|崩溃|emo|不顺|不太顺|没过|凉了|烦死|累死|压力大|心情|情绪|吐槽|安慰/i;

/** 明确的检索 / 办理意图：情绪句里夹了任务时不短路，只处理任务部分 */
const EXPLICIT_TASK =
  /帮我|请|麻烦|查一下|查下|查查|查询|搜索|搜一下|搜搜|top\s*\d+/i;

/** 求助式发问没有可查证的外部对象，即使带了「查一下」也不该联网 */
const HELPLESS_TALK = /怎么办|咋办|如何是好|不知道该|不知道怎么/i;

/**
 * 本轮是否为纯倾诉 / 求助（不夹带明确任务）。
 * 供主链路复用：选情绪采样档、以及后续关闭工具轮次都用它，避免判意漂移。
 */
export const isEmotionalTurn = (query: string): boolean => {
  const trimmed = query.trim();
  if (HELPLESS_TALK.test(trimmed)) return true;
  return EMOTIONAL_TALK.test(trimmed) && !EXPLICIT_TASK.test(trimmed);
};

/** 强检索信号：出现即按实时查询处理 */
const STRONG_LIVE_SIGNAL =
  /实时|热搜|热榜|热点|热度|新闻|榜单|排行榜|微博|股价|汇率|搜索|搜一下|搜搜|帮我搜|查一下|查查|查询|帮我查|top\s*\d+/i;

/**
 * 「今天 / 最近 / 现在」只是时间词，本身不构成检索意图：
 * 「今天面试不太顺」「最近怎么样」不该触发联网。只有同时出现查询动作或
 * 可查证的时限状态时才算实时查询（「现在几点」「最近有什么进展」）。
 * 实时对象词（新闻/股价/汇率等）已在强信号里，这里不重复。
 */
const WEAK_TIME = /今天|今日|现在|当前|最近|近期|最新/i;
const QUERY_SIGNAL =
  /查|搜|几点|什么时候|多少|有没有|开了没|开没|截止|进展|消息|行情|价格|通知|公告|名单|成绩|结果/i;

export const isLiveInfoQuery = (query: string): boolean => {
  const trimmed = query.trim();
  // 天气查询由 fetchWeatherInfo 处理，不走 Tavily
  if (/天气/.test(trimmed)) return false;
  // 倾诉短路放在关键词之前：否则「今天面试不太顺」会被「今天」抢去联网
  if (isEmotionalTurn(trimmed)) return false;
  if (STRONG_LIVE_SIGNAL.test(trimmed)) return true;
  if (WEAK_TIME.test(trimmed) && QUERY_SIGNAL.test(trimmed)) return true;
  // 短查询兜底：默认不搜，只有「像实体/术语」的短输入才按实时查询处理。
  // 正向信号：含数字/字母/书名号（型号、榜单、作品名），或 2-6 个汉字。
  // 反向过滤：命中问候/确认/请求句式、叠词拟声，或含句法成分（语气词、代词、疑问词、能愿动词等），
  //          说明它是一句话而不是一个词，交给普通对话/工具链处理。
  // 这样「好吧」「嘻嘻」「哈哈哈」不会被当成搜索，「特朗普」「李二毛」「iPhone 16」仍会命中。
  if (trimmed.length > 0 && trimmed.length <= 20) {
    const looksLikeEntity =
      /[0-9A-Za-z]/.test(trimmed) ||
      /[《「『“《]/.test(trimmed) ||
      /^[\u4e00-\u9fa5]{2,6}[。.!！?？]?$/.test(trimmed);
    if (!looksLikeEntity) return false;
    const isUtterance =
      /^([\u4e00-\u9fa5])\1+$/.test(trimmed) || // AA/AAA：嘻嘻、哈哈、嘿嘿
      /^([\u4e00-\u9fa5])([\u4e00-\u9fa5])\2$/.test(trimmed) || // ABB：笑嘻嘻、呼啦啦
      /^([\u4e00-\u9fa5])\1([\u4e00-\u9fa5])\2$/.test(trimmed) || // AABB：嘻嘻哈哈
      /^([\u4e00-\u9fa5]{2})\1$/.test(trimmed) || // ABAB：研究研究
      /^([\u4e00-\u9fa5])[不没]\1$/.test(trimmed) || // A不A/A没A：好不好、是不是
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
