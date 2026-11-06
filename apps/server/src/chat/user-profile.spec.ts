import { describe, expect, it } from 'vitest';
import {
  extractUserPreferences,
  formatUserPreferences,
  mergeUserPreferences,
  parseUserPreferences,
} from './user-profile.js';

describe('用户画像：只记显式声明的白名单偏好', () => {
  it('显式声明才记，且只认四类白名单', () => {
    const prefs = extractUserPreferences('记住，以后回答用要点式');
    expect(prefs).toHaveLength(1);
    expect(prefs[0].type).toBe('输出格式');
    expect(prefs[0].value).toBe('要点式');
  });

  it('没有显式声明就什么都不记', () => {
    expect(extractUserPreferences('今天天气怎么样')).toEqual([]);
    expect(extractUserPreferences('我明天要开会')).toEqual([]);
  });

  it('事实类内容不记', () => {
    expect(extractUserPreferences('记住我明天要去上海出差')).toEqual([]);
  });

  it('否定句不记成正向偏好', () => {
    expect(extractUserPreferences('以后不要用列表回答')).toEqual([]);
  });

  it('称呼 / 语言 / 单位都能抽到', () => {
    expect(extractUserPreferences('记住：叫我小明')[0]).toMatchObject({
      type: '称呼',
      value: '小明',
    });
    expect(extractUserPreferences('以后用中文回答')[0]).toMatchObject({
      type: '语言',
      value: '中文',
    });
    expect(extractUserPreferences('统一用摄氏度')[0]).toMatchObject({
      type: '单位',
      value: '摄氏度',
    });
  });

  it('同类型覆盖，且最多保留白名单类型数', () => {
    const merged = mergeUserPreferences(
      [{ type: '语言', value: '英文', updatedAt: '2026-01-01T00:00:00Z' }],
      [{ type: '语言', value: '中文', updatedAt: '2026-01-02T00:00:00Z' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe('中文');

    const all = mergeUserPreferences([], [
      { type: '称呼', value: '小明', updatedAt: '2026-01-01T00:00:00Z' },
      { type: '输出格式', value: '要点式', updatedAt: '2026-01-01T00:00:00Z' },
      { type: '语言', value: '中文', updatedAt: '2026-01-01T00:00:00Z' },
      { type: '单位', value: '摄氏度', updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(all).toHaveLength(4);
  });

  it('解析数据库 JSON 时丢弃脏数据', () => {
    const parsed = parseUserPreferences([
      { type: '语言', value: '中文', updatedAt: '2026-01-01T00:00:00Z' },
      { type: '密秘', value: '不该记' },
      null,
      'x',
      { type: '称呼' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('语言');
    expect(parseUserPreferences(undefined)).toEqual([]);
    expect(parseUserPreferences('not-an-array')).toEqual([]);
  });

  it('格式化成提示词正文', () => {
    expect(
      formatUserPreferences([
        { type: '称呼', value: '小明', updatedAt: '2026-01-01T00:00:00Z' },
        { type: '输出格式', value: '要点式', updatedAt: '2026-01-01T00:00:00Z' },
      ]),
    ).toBe('- 称呼：小明\n- 输出格式：要点式');
  });
});
