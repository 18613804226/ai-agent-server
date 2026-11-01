import { describe, expect, it } from 'vitest';
import { generalAgent } from './agent.js';
import { createChatTools, createGeneralTools } from './tools.js';

const names = (tools: ReturnType<typeof createChatTools>) =>
  tools.map((tool) => tool.definition.function.name);

describe('general-agent 工具集', () => {
  it('general 包含联网搜索 + 天气/计算/农历节日', () => {
    expect(names(createGeneralTools())).toEqual([
      'fetchWeatherInfo',
      'calculator',
      'web_search',
      'festival_info',
    ]);
  });

  it('chat 由后端自己执行 web_search，工具集不重复暴露搜索工具', () => {
    expect(names(createChatTools())).toEqual([
      'fetchWeatherInfo',
      'calculator',
      'festival_info',
    ]);
  });

  it('generalAgent 直接复用同一套工具与 prompt', () => {
    expect(generalAgent.id).toBe('general');
    expect(generalAgent.tools).toEqual(createGeneralTools());
    expect(generalAgent.buildSystemPrompt({ query: '几号是春节' })).toContain(
      'festival_info',
    );
  });
});
