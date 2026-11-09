import { describe, expect, it } from 'vitest';
import {
  formatIndexedWebSearchContext,
  type WebSearchResult,
} from './web-search.js';
import { SearchSession } from './search-session.js';

const rows = (...urls: string[]): WebSearchResult[] =>
  urls.map((url, i) => ({
    title: `来源${i + 1}`,
    url,
    content: `摘要${i + 1}`,
  }));

describe('SearchSession：本轮联网来源唯一事实来源', () => {
  it('按分配顺序编号，list 形状可直接下发', () => {
    const session = new SearchSession();
    const indexed = session.add(rows('https://a.com/1', 'https://b.com/2'), {
      origin: 'prefetch',
      query: '今天的新闻',
    });

    expect(indexed.map((row) => row.index)).toEqual([1, 2]);
    expect(session.list()).toEqual([
      { kind: 'web', index: 1, title: '来源1', url: 'https://a.com/1' },
      { kind: 'web', index: 2, title: '来源2', url: 'https://b.com/2' },
    ]);
  });

  it('跨多次检索编号连续：预检索 + 模型补搜不撞号', () => {
    const session = new SearchSession();
    session.add(rows('https://a.com/1', 'https://b.com/2'), {
      origin: 'prefetch',
      query: 'q1',
    });
    const second = session.add(rows('https://c.com/3'), {
      origin: 'tool',
      query: 'q2',
    });

    expect(second.map((row) => row.index)).toEqual([3]);
    expect(session.list().map((row) => row.index)).toEqual([1, 2, 3]);
    expect(session.stats()).toEqual({ prefetch: 2, tool: 1 });
  });

  it('同 URL 去重（含 hash / 末尾斜杠），不重复占号', () => {
    const session = new SearchSession();
    session.add(rows('https://a.com/1'), { origin: 'prefetch', query: 'q1' });
    const dup = session.add(
      rows('https://a.com/1#top', 'https://a.com/1/', 'https://b.com/2'),
      { origin: 'tool', query: 'q2' },
    );

    expect(dup.map((row) => row.index)).toEqual([2]);
    expect(session.list().map((row) => row.url)).toEqual([
      'https://a.com/1',
      'https://b.com/2',
    ]);
  });

  it('达到上限后不再分配编号，提示词与 list 始终一致', () => {
    const session = new SearchSession(2);
    const first = session.add(
      rows('https://a.com/1', 'https://b.com/2', 'https://c.com/3'),
      { origin: 'prefetch', query: 'q1' },
    );
    const second = session.add(rows('https://d.com/4'), {
      origin: 'tool',
      query: 'q2',
    });

    expect(first.map((row) => row.index)).toEqual([1, 2]);
    expect(second).toHaveLength(0);
    expect(formatIndexedWebSearchContext(second)).toBe('');
    expect(session.list()).toHaveLength(2);
  });

  it('list 不泄漏 origin / query 等内部元数据', () => {
    const session = new SearchSession();
    session.add(rows('https://a.com/1'), {
      origin: 'tool',
      query: '不该下发',
    });

    expect(JSON.stringify(session.list())).not.toContain('不该下发');
    expect(session.list()[0]).not.toHaveProperty('origin');
  });

  it('publishedDate 仅在有值时下发', () => {
    const session = new SearchSession();
    session.add(
      [{ ...rows('https://a.com/1')[0], publishedDate: '2026-11-09' }],
      { origin: 'prefetch', query: 'q' },
    );

    expect(session.list()[0].publishedDate).toBe('2026-11-09');
    expect(session.list()[0]).not.toHaveProperty('publishedDate', undefined);
  });
});
