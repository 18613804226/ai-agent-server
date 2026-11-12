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

/** 博查响应：官方开放平台 Web Search API，结果在 webPages.value[] */
interface BochaSearchResponse {
  webPages?: {
    value?: Array<{
      name?: string;
      url?: string;
      /** 长摘要（summary=true 时返回），比 snippet 更适合喂给模型 */
      summary?: string;
      snippet?: string;
      datePublished?: string | null;
    }>;
  };
}

/** 联网搜索 provider：tavily（默认，境外）| bocha（国内，博查） */
export type WebSearchProvider = 'tavily' | 'bocha';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;
const BOCHA_DEFAULT_URL = 'https://api.bochaai.com/v1/web-search';

interface WebSearchFailure extends Error {
  searchStatus?: number;
  searchCode?: string;
}

/** provider 未配或写了未知值一律回落 tavily，避免配置笔误让线上突然断网 */
export function webSearchProvider(): WebSearchProvider {
  const raw = (process.env.WEB_SEARCH_PROVIDER || '').trim().toLowerCase();
  return raw === 'bocha' ? 'bocha' : 'tavily';
}

function searchTimeoutMs(): number {
  const raw = Number(process.env.WEB_SEARCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 && raw <= 60_000
    ? Math.trunc(raw)
    : DEFAULT_TIMEOUT_MS;
}

/** 两个 provider 的结果收敛成同一份契约：URL 协议白名单 + 摘要限长 + 最多 10 条 */
function normalizeResults(
  rows: Array<{
    title?: string;
    url?: string;
    content?: string;
    publishedDate?: string | null;
  }>,
): WebSearchResult[] {
  return rows
    .flatMap((row) => {
      if (!row.title || !row.url || !row.content) return [];
      try {
        const url = new URL(row.url);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
      } catch {
        return [];
      }
      return [
        {
          title: row.title.trim(),
          url: row.url,
          content: row.content.replace(/\s+/g, ' ').trim().slice(0, 400),
          ...(row.publishedDate
            ? { publishedDate: String(row.publishedDate) }
            : {}),
        },
      ];
    })
    .slice(0, MAX_RESULTS);
}

/** 对外只给收敛文案；status/code 挂在 error 上给统一打点用，不泄漏内部报错原文 */
function toSearchFailure(error: unknown, provider: string): WebSearchFailure {
  const status = axios.isAxiosError(error)
    ? error.response?.status
    : undefined;
  const code = axios.isAxiosError(error) ? error.code : undefined;
  console.error(`${provider} 联网搜索请求失败:`, { status, code });
  const wrapped = new Error(
    '实时搜索服务暂时不可用，请稍后重试。',
  ) as WebSearchFailure;
  wrapped.searchStatus = status;
  wrapped.searchCode = code;
  return wrapped;
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
  /实时|热搜|热榜|热点|热度|新闻|榜单|排行榜|微博|股价|汇率|搜索|搜一下|搜搜|帮我搜|查一下|查查|查询|帮我查|top\s*\d+|上映|开播|夺冠|开奖|财报/i;

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

/**
 * Tavily adapter（默认，境外）。保留原有请求形状，既有部署与单测平滑过渡。
 * 直接调用它不会打点，业务侧请统一用 searchWeb()。
 */
export async function searchTavily(
  query: string,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('实时搜索未配置：请在后端环境变量中设置 TAVILY_API_KEY。');
  }

  try {
    const response = await axios.post<TavilySearchResponse>(
      'https://api.tavily.com/search',
      {
        api_key: apiKey,
        // ⚠️ 不要把当天日期拼进检索词：会把「2026-11 北京活动 / 火车票」这类
        //    带日期的资讯页全召回，问天气却搜出一堆不相关来源。时效交给 provider 参数。
        query,
        topic: 'general',
        search_depth: 'advanced',
        max_results: MAX_RESULTS,
        include_answer: false,
        include_raw_content: false,
      },
      { timeout: searchTimeoutMs(), signal },
    );
    const rows = Array.isArray(response.data.results)
      ? response.data.results
      : [];
    return normalizeResults(
      rows.map((result) => ({
        title: result.title,
        url: result.url,
        content: result.content,
        publishedDate: result.published_date,
      })),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw toSearchFailure(error, 'Tavily');
  }
}

/**
 * 博查 Bocha adapter（国内，可选）。
 * 按官方开放平台：POST /v1/web-search + Bearer Key，
 * 响应 webPages.value[] → name / url / summary|snippet / datePublished。
 * endpoint 可用 BOCHA_API_URL 覆盖，方便换域名或走代理。
 */
export async function searchBocha(
  query: string,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const apiKey = process.env.BOCHA_API_KEY;
  if (!apiKey) {
    throw new Error('实时搜索未配置：请在后端环境变量中设置 BOCHA_API_KEY。');
  }
  const endpoint = process.env.BOCHA_API_URL?.trim() || BOCHA_DEFAULT_URL;
  try {
    const response = await axios.post<BochaSearchResponse>(
      endpoint,
      {
        // ⚠️ 同 Tavily：日期不进检索词，时效由 freshness 控制
        query,
        freshness: 'noLimit',
        summary: true,
        count: MAX_RESULTS,
      },
      {
        timeout: searchTimeoutMs(),
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const rows = Array.isArray(response.data?.webPages?.value)
      ? response.data.webPages.value
      : [];
    return normalizeResults(
      rows.map((result) => ({
        title: result.name,
        url: result.url,
        content: result.summary || result.snippet,
        publishedDate: result.datePublished,
      })),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw toSearchFailure(error, 'Bocha');
  }
}

/**
 * 业务侧统一入口：按 WEB_SEARCH_PROVIDER 分发 + 统一打点。
 * 日志不打印 query 和 API Key（用户隐私 / 凭据），只记 provider、结果数、耗时、失败原因。
 */
export async function searchWeb(
  query: string,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const provider = webSearchProvider();
  const startedAt = Date.now();
  try {
    const results =
      provider === 'bocha'
        ? await searchBocha(query, signal)
        : await searchTavily(query, signal);
    console.log(
      `[web-search] ${JSON.stringify({
        provider,
        ok: true,
        results: results.length,
        durationMs: Date.now() - startedAt,
      })}`,
    );
    return results;
  } catch (error) {
    // 客户端主动断开不算服务失败，别往日志里灌噪音
    if (!signal?.aborted) {
      const failure = error as WebSearchFailure;
      console.warn(
        `[web-search] ${JSON.stringify({
          provider,
          ok: false,
          results: 0,
          durationMs: Date.now() - startedAt,
          ...(failure.searchStatus !== undefined
            ? { status: failure.searchStatus }
            : {}),
          ...(failure.searchCode ? { code: failure.searchCode } : {}),
          reason: error instanceof Error ? error.message : '未知错误',
        })}`,
      );
    }
    throw error;
  }
}

/** 带全局编号的检索结果：编号由 SearchSession 分配，跨多次搜索连续 */
export interface IndexedWebSearchResult extends WebSearchResult {
  index: number;
}

/**
 * 与 formatWebSearchContext 完全同文案，但编号由调用方给定。
 * 模型主动补搜时用它，编号才不会与后端预检索的 [1]、[2] 撞车。
 */
export function formatIndexedWebSearchContext(
  rows: IndexedWebSearchResult[],
): string {
  // 只放数据：引用规则统一写在 system prompt（chat-prompt.ts）。
  // 以前把「（引用请用 [序号]…）」这类内部指令拼进工具结果，模型会原样复述进思考/正文。
  return rows
    .map(
      (result) =>
        `[${result.index}] ${result.title}\nURL: ${result.url}\n` +
        `发布时间: ${result.publishedDate || '来源未提供'}\n摘要: ${result.content}`,
    )
    .join('\n\n');
}

/** 独立使用（无 SearchSession）时按传入顺序从 1 编号 */
export function formatWebSearchContext(results: WebSearchResult[]): string {
  return formatIndexedWebSearchContext(
    results.map((result, index) => ({ ...result, index: index + 1 })),
  );
}
