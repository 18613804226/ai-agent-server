import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, estimateTokens } from './chat-prompt.js';

describe('estimateTokens', () => {
  it('空串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('CJK 每字约 1 token', () => {
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('英文每 3.5 字符约 1 token（向上取整）', () => {
    expect(estimateTokens('hello')).toBe(2); // 5 / 3.5 = 1.43 -> 2
    expect(estimateTokens('abcdefg')).toBe(2); // 7 / 3.5 = 2
  });

  it('中英混排按各自规则累加', () => {
    // 2 CJK + 5 个英文字符：2 + 5/3.5 = 3.43 -> 4
    expect(estimateTokens('你好hello')).toBe(4);
  });

  it('标点按非 CJK 计', () => {
    // 4 CJK + 1 个全角逗号：4 + 1/3.5 = 4.29 -> 5
    expect(estimateTokens('你好，世界')).toBe(5);
  });
});

describe('buildSystemPrompt', () => {
  const now = new Date('2026-01-02T03:04:05Z');

  it('包含身份、时间与工具规则', () => {
    const prompt = buildSystemPrompt({
      context: '',
      historySourceSummary: '此前对话未引用知识库资料。',
      webSearchContext: '',
      now,
    });
    expect(prompt).toContain('你是一个专属的 AI 智能助手');
    expect(prompt).toContain('你的名字叫toto');
    expect(prompt).toContain('2026');
    expect(prompt).toContain('fetchWeatherInfo');
  });

  it('注入参考资料 / 历史来源 / 联网搜索结果', () => {
    const prompt = buildSystemPrompt({
      context: '【来源：a.pdf】\n内容A',
      historySourceSummary: 'a.pdf（当前已停用）',
      webSearchContext: '【搜索结果】...',
      now,
    });
    expect(prompt).toContain('【参考资料】：\n      【来源：a.pdf】\n内容A');
    expect(prompt).toContain('【历史对话来源状态】：\n      a.pdf（当前已停用）');
    expect(prompt).toContain('【本轮联网搜索结果】：\n      【搜索结果】...');
  });

  it('注入权威农历日期，并提示以本轮计算为准', () => {
    const prompt = buildSystemPrompt({
      context: '',
      historySourceSummary: '此前对话未引用知识库资料。',
      webSearchContext: '',
      festivalContext: '【权威农历日期】\n2027年春节：公历 2027-02-06',
      now,
    });
    expect(prompt).toContain('【权威农历日期】');
    expect(prompt).toContain('2027-02-06');
    expect(prompt).toContain('festival_info');
  });

  it('空值使用兜底文案', () => {
    const prompt = buildSystemPrompt({
      context: '',
      historySourceSummary: '此前对话未引用知识库资料。',
      webSearchContext: '',
      now,
    });
    expect(prompt).toContain('本轮没有提供知识库参考资料。');
    expect(prompt).toContain('本轮未执行联网搜索。');
  });

  it('同一时间输入产出稳定（可快照）', () => {
    const parts = {
      context: 'CTX',
      historySourceSummary: 'HIST',
      webSearchContext: 'WEB',
      now,
    };
    expect(buildSystemPrompt(parts)).toBe(buildSystemPrompt(parts));
  });
});
