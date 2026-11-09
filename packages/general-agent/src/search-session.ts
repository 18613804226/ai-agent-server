import type {
  IndexedWebSearchResult,
  WebSearchResult,
} from './web-search.js';

/** 下发/落库的联网来源形状，与既有 webSources 完全一致 */
export interface WebSource {
  kind: 'web';
  index: number;
  title: string;
  url: string;
  publishedDate?: string;
}

export type SearchOrigin = 'prefetch' | 'tool';

interface StoredSource extends WebSource {
  origin: SearchOrigin;
  query: string;
}

/** 同一 URL 只占一个编号：去掉 hash 与末尾斜杠，保留 query（同域不同文章仍算两条） */
function normalizeUrl(url: string): string {
  return url.trim().replace(/#.*$/, '').replace(/\/$/, '');
}

/**
 * 一轮对话内所有联网检索结果的唯一事实来源。
 *
 * 后端预检索与模型主动调用 web_search 都往这里写：编号按「分配顺序」全局连续递增，
 * handler 用 add() 返回的带号结果生成提示词，末尾的 sources 事件/落库/sourcesCount
 * 一律从 list() 派生，正文 [n] 与来源列表才能始终对齐。
 *
 * ⚠️ 必须 per-request 创建：ChatService 是单例，绝不能把实例挂在共享字段或模块作用域，
 *    否则并发请求会把 A 的来源串到 B 的回答里。
 */
export class SearchSession {
  private readonly rows: StoredSource[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly maxSources = 20) {}

  /**
   * 登记一批结果，返回「已分配全局编号」的行。
   * 超上限 / URL 重复的行会被跳过，所以调用方拿到的文本与 list() 天然一致。
   */
  add(
    results: WebSearchResult[],
    meta: { origin: SearchOrigin; query: string },
  ): IndexedWebSearchResult[] {
    const allocated: IndexedWebSearchResult[] = [];
    for (const result of results) {
      if (!result?.url) continue;
      if (this.rows.length >= this.maxSources) break;
      const key = normalizeUrl(result.url);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const index = this.rows.length + 1;
      this.rows.push({
        kind: 'web',
        index,
        title: result.title || '联网来源',
        url: result.url,
        ...(result.publishedDate
          ? { publishedDate: String(result.publishedDate) }
          : {}),
        origin: meta.origin,
        query: meta.query,
      });
      allocated.push({ ...result, index });
    }
    return allocated;
  }

  /** 纯下发形状：origin/query 等内部元数据不泄漏给客户端、不落进 JSON 列 */
  list(): WebSource[] {
    return this.rows.map(({ kind, index, title, url, publishedDate }) => ({
      kind,
      index,
      title,
      url,
      ...(publishedDate ? { publishedDate } : {}),
    }));
  }

  get size(): number {
    return this.rows.length;
  }

  /** 打点用：按发起方统计条数，不打印 query 原文 */
  stats(): Record<SearchOrigin, number> {
    return {
      prefetch: this.rows.filter((row) => row.origin === 'prefetch').length,
      tool: this.rows.filter((row) => row.origin === 'tool').length,
    };
  }
}
