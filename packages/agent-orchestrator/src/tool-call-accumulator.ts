// 流式响应里的 tool_calls 是分片到达的：
//   第 1 片: { index: 0, id: 'call_xxx', function: { name: 'calculator', arguments: '{"expr' } }
//   第 2 片: { index: 0, function: { arguments: 'ession":"1+1"}' } }
// 必须按 index 归并、arguments 拼接，才能还原成一次完整的工具调用。

export interface AccumulatedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ToolCallAccumulator = Record<number, AccumulatedToolCall>;

/** OpenAI 兼容接口返回的 delta.tool_calls 单项（只声明用到的字段） */
export interface ToolCallDelta {
  index?: number | null;
  id?: string | null;
  type?: string | null;
  function?: { name?: string | null; arguments?: string | null } | null;
}

/**
 * 把一批 delta.tool_calls 合并进累加器（就地修改并返回，便于链式使用）。
 * name 分片到达时要拼接，arguments 永远拼接，id/type 取首个非空值。
 */
export function mergeToolCallDeltas(
  acc: ToolCallAccumulator,
  deltas: readonly ToolCallDelta[],
): ToolCallAccumulator {
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    const slot = (acc[index] ??= {
      id: '',
      type: 'function',
      function: { name: '', arguments: '' },
    });
    if (delta.id) slot.id += delta.id;
    if (delta.function?.name) slot.function.name += delta.function.name;
    if (delta.function?.arguments) slot.function.arguments += delta.function.arguments;
  }
  return acc;
}

/**
 * 收尾：按 index 升序输出，丢掉没有函数名的残缺分片
 * （usage chunk / 结束帧有时会带一个空的 tool_calls 项）。
 */
export function finalizeToolCalls(
  acc: ToolCallAccumulator,
): AccumulatedToolCall[] {
  return Object.keys(acc)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => acc[index])
    .filter((call) => call.function.name.length > 0);
}
