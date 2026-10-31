import { describe, expect, it } from 'vitest';
import {
  finalizeToolCalls,
  mergeToolCallDeltas,
  type ToolCallAccumulator,
} from './tool-call-accumulator.js';

const acc = (): ToolCallAccumulator => ({});

describe('mergeToolCallDeltas', () => {
  it('按 index 拼接分片的 arguments，还原出合法 JSON', () => {
    const a = acc();
    mergeToolCallDeltas(a, [
      {
        index: 0,
        id: 'call_abc',
        type: 'function',
        function: { name: 'calculator', arguments: '{"expression"' },
      },
    ]);
    mergeToolCallDeltas(a, [
      { index: 0, function: { arguments: ': "(100+20)*0.85"}' } },
    ]);

    expect(finalizeToolCalls(a)).toEqual([
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'calculator', arguments: '{"expression": "(100+20)*0.85"}' },
      },
    ]);
    expect(
      JSON.parse(finalizeToolCalls(a)[0].function.arguments),
    ).toEqual({ expression: '(100+20)*0.85' });
  });

  it('一轮里多个工具调用按 index 各自独立累积', () => {
    const a = acc();
    mergeToolCallDeltas(a, [
      { index: 0, id: 'c0', function: { name: 'calculator', arguments: '{"a":1}' } },
      { index: 1, id: 'c1', function: { name: 'fetchWeatherInfo', arguments: '{"b":2}' } },
    ]);

    expect(finalizeToolCalls(a).map((c) => c.id)).toEqual(['c0', 'c1']);
    expect(finalizeToolCalls(a).map((c) => c.function.name)).toEqual([
      'calculator',
      'fetchWeatherInfo',
    ]);
  });

  it('name 本身也可能被拆成多片，要拼接而不是覆盖', () => {
    const a = acc();
    mergeToolCallDeltas(a, [{ index: 0, function: { name: 'fetch' } }]);
    mergeToolCallDeltas(a, [{ index: 0, function: { name: 'WeatherInfo' } }]);

    expect(finalizeToolCalls(a)[0].function.name).toBe('fetchWeatherInfo');
  });

  it('缺少 index 时按 0 处理', () => {
    const a = acc();
    mergeToolCallDeltas(a, [{ function: { name: 'calculator', arguments: '{}' } }]);

    expect(finalizeToolCalls(a)).toHaveLength(1);
  });

  it('丢弃没有函数名的残缺分片（usage/结束帧）', () => {
    const a = acc();
    mergeToolCallDeltas(a, [
      { index: 0, id: 'c0', function: { name: 'calculator', arguments: '{}' } },
      { index: 1 },
    ]);

    expect(finalizeToolCalls(a)).toHaveLength(1);
  });

  it('arguments 为空字符串时也能收尾，不产生非法 JSON 崩溃', () => {
    const a = acc();
    mergeToolCallDeltas(a, [{ index: 0, id: 'c0', function: { name: 'calculator' } }]);

    expect(finalizeToolCalls(a)[0].function.arguments).toBe('');
  });

  it('没有 tool_calls 时返回空数组', () => {
    expect(finalizeToolCalls(acc())).toEqual([]);
    expect(finalizeToolCalls(mergeToolCallDeltas(acc(), []))).toEqual([]);
  });
});
