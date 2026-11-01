import { describe, expect, it, vi } from 'vitest';
import { ToolRuntime, validateToolArgs } from './tool-runtime.js';
import type { RegisteredTool } from './types.js';

function tool(
  handler: (args: Record<string, unknown>) => unknown,
  parameters: Record<string, unknown> = {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
  },
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'calculator',
        description: '计算器',
        parameters,
      },
    },
    handler: handler as any,
  };
}

describe('validateToolArgs', () => {
  it('缺少必填参数时返回错误', () => {
    const t = tool(() => 'ok');
    expect(validateToolArgs(t.definition, {})).toBe('缺少必填参数 expression');
  });

  it('参数类型不匹配时返回错误', () => {
    const t = tool(() => 'ok');
    expect(validateToolArgs(t.definition, { expression: 123 })).toBe(
      '参数 expression 应为 string',
    );
  });

  it('支持 enum 校验', () => {
    const t = tool(() => 'ok', {
      type: 'object',
      properties: { unit: { type: 'string', enum: ['c', 'f'] } },
    });
    expect(validateToolArgs(t.definition, { unit: 'k' })).toContain(
      '必须是 c / f 之一',
    );
    expect(validateToolArgs(t.definition, { unit: 'c' })).toBeNull();
  });

  it('未声明的类型不拦截', () => {
    const t = tool(() => 'ok', {
      type: 'object',
      properties: { any: {} },
    });
    expect(validateToolArgs(t.definition, { any: { nested: true } })).toBeNull();
  });
});

describe('ToolRuntime', () => {
  it('参数校验失败时不执行 handler', async () => {
    const handler = vi.fn(() => 'ok');
    const runtime = new ToolRuntime();
    const result = await runtime.execute(tool(handler), {}, {
      toolName: 'calculator',
    });
    expect(result).toContain('工具参数错误');
    expect(handler).not.toHaveBeenCalled();
  });

  it('正常执行并返回字符串', async () => {
    const runtime = new ToolRuntime();
    const result = await runtime.execute(tool(() => '42'), { expression: '6*7' }, {
      toolName: 'calculator',
    });
    expect(result).toBe('42');
  });

  it('handler 抛错转成可读文本，不打断循环', async () => {
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      tool(() => {
        throw new Error('boom');
      }),
      { expression: '1+1' },
      { toolName: 'calculator' },
    );
    expect(result).toContain('boom');
  });

  it('执行超时返回超时文本', async () => {
    const runtime = new ToolRuntime({ timeoutMs: 20 });
    const result = await runtime.execute(
      tool(() => new Promise(() => {})),
      { expression: '1+1' },
      { toolName: 'calculator' },
    );
    expect(result).toContain('执行超时');
  });

  it('结果超过上限时截断', async () => {
    const runtime = new ToolRuntime({ maxResultChars: 5 });
    const result = await runtime.execute(
      tool(() => '1234567890'),
      { expression: '1+1' },
      { toolName: 'calculator' },
    );
    expect(result).toContain('12345');
    expect(result).toContain('工具结果已截断');
  });

  it('已取消的 signal 不执行 handler', async () => {
    const handler = vi.fn(() => 'ok');
    const controller = new AbortController();
    controller.abort();
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      tool(handler),
      { expression: '1+1' },
      { toolName: 'calculator', signal: controller.signal },
    );
    expect(result).toContain('已取消');
    expect(handler).not.toHaveBeenCalled();
  });
});
