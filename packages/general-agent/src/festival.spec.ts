import { describe, expect, it } from 'vitest';
import {
  buildFestivalContext,
  festivalTool,
  getFestivalDate,
} from './festival.js';

describe('getFestivalDate', () => {
  it('返回春节的准确公历日期', () => {
    expect(getFestivalDate('春节', 2026)).toBe('2026-02-17');
    expect(getFestivalDate('春节', 2027)).toBe('2027-02-06');
  });

  it('支持别名与节气类节日', () => {
    expect(getFestivalDate('中秋', 2026)).toBe('2026-09-25');
    expect(getFestivalDate('端午', 2027)).toBe('2027-06-09');
    expect(getFestivalDate('清明', 2026)).toBe('2026-04-05');
  });

  it('未知节日返回可读提示', () => {
    expect(getFestivalDate('不存在的节日', 2026)).toContain('未找到');
  });

  it('不传年份时顺延到最近一次即将到来的年份', () => {
    const now = new Date('2026-11-01T03:07:00Z'); // 上海时间 2026-11-01，2026 春节已过
    expect(getFestivalDate('春节', undefined, now)).toBe('2027-02-06');
  });
});

describe('buildFestivalContext', () => {
  const now = new Date('2026-11-01T03:07:00Z'); // 上海时间 2026-11-01

  it('没写年份时取最近一次尚未到来的节日，并给出剩余天数', () => {
    const ctx = buildFestivalContext('几号是春节', now);
    expect(ctx).toContain('2027年春节');
    expect(ctx).toContain('2027-02-06');
    expect(ctx).toContain('农历正月初一');
    expect(ctx).toContain('今天：2026-11-01');
    expect(ctx).toContain('距离今天（2026-11-01）还有 97 天');
  });

  it('明确年份按用户说的算，已过则标注已过去天数', () => {
    const past = buildFestivalContext('2026年的春节是哪天', now);
    expect(past).toContain('2026-02-17');
    expect(past).toContain('已过去 257 天');
    expect(buildFestivalContext('27年的春节', now)).toContain('2027-02-06');
  });

  it('支持今年 / 明年', () => {
    expect(buildFestivalContext('今年春节', now)).toContain('2026-02-17');
    expect(buildFestivalContext('明年春节', now)).toContain('2027-02-06');
  });

  it('长别名不会重复输出（中秋节 ≠ 中秋 + 中秋节）', () => {
    const ctx = buildFestivalContext('2026年中秋节', now);
    expect(ctx.match(/2026年中秋/g)).toHaveLength(1);
    expect(ctx).toContain('2026-09-25');
  });

  it('一次问多个节日时逐条计算，并各自给出天数', () => {
    const ctx = buildFestivalContext('2027年春节和中秋', now);
    expect(ctx).toContain('2027-02-06');
    expect(ctx).toContain('2027-09-15');
    expect(ctx).toContain('还有 97 天');
    expect(ctx).toContain('还有 318 天');
  });

  it('识别「过年」别名，并给出距离下一次春节的天数', () => {
    const ctx = buildFestivalContext('距离过年还有几天啊', now);
    expect(ctx).toContain('2027年春节');
    expect(ctx).toContain('2027-02-06');
    expect(ctx).toContain('距离今天（2026-11-01）还有 97 天');
    expect(ctx).not.toContain('已过去');
  });

  it('没提到节日时不注入，避免污染 prompt', () => {
    expect(buildFestivalContext('今天天气怎么样', now)).toBe('');
    expect(buildFestivalContext('', now)).toBe('');
  });
});

describe('festivalTool', () => {
  it('工具定义和 handler 可用，返回值附带年份与剩余天数', async () => {
    expect(festivalTool.definition.function.name).toBe('festival_info');
    const result = await festivalTool.handler({ name: '春节', year: 2027 });
    expect(result).toContain('2027年春节');
    expect(result).toContain('2027-02-06');
    expect(result).toContain('距离今天');
    expect(result).toContain('天');
  });

  it('不传年份时返回即将到来的那次，而不是已过去的那次', async () => {
    const result = await festivalTool.handler({ name: '春节' });
    expect(result).toContain('年春节');
    expect(result).toContain('距离今天');
    expect(result).not.toContain('已过去');
  });

  it('未知节日原样返回提示，不拼天数', async () => {
    await expect(
      festivalTool.handler({ name: '不存在的节日', year: 2026 }),
    ).resolves.toContain('未找到');
  });
});
