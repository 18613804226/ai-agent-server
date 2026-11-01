import { describe, expect, it } from 'vitest';
import { ContextManager, estimateTextTokens } from './context-manager.js';

function toolMessage(index: number, content = 'x'.repeat(1000)) {
  return {
    role: 'tool',
    name: 'read_file',
    tool_call_id: `call_${index}`,
    content,
  };
}

describe('estimateTextTokens', () => {
  it('中文按字、英文按 4 字符估算', () => {
    expect(estimateTextTokens('你好')).toBe(2);
    expect(estimateTextTokens('abcdefgh')).toBe(2);
  });
});

describe('ContextManager', () => {
  it('只压缩最近 N 个之外的 tool 结果', () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      toolMessage(0),
      toolMessage(1),
      toolMessage(2),
      toolMessage(3),
      toolMessage(4),
    ];
    const manager = new ContextManager({
      keepRecentToolResults: 2,
      maxInputTokens: 0,
    });

    const stats = manager.compact(messages);

    expect(stats.compactedToolResults).toBe(3);
    expect(stats.afterTokens).toBeLessThan(stats.beforeTokens);
    expect(messages[2].content).toContain('【已压缩】');
    expect(messages[3].content).toContain('【已压缩】');
    expect(messages[4].content).toContain('【已压缩】');
    // 最近两个 tool 结果保留全文
    expect(messages[5].content).toBe('x'.repeat(1000));
    expect(messages[6].content).toBe('x'.repeat(1000));
  });

  it('当前轮一次读多个文件时全部保留，下一轮才压缩旧结果', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: '一次读 5 个文件' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'batch' }] },
      toolMessage(0),
      toolMessage(1),
      toolMessage(2),
      toolMessage(3),
      toolMessage(4),
    ];
    const manager = new ContextManager({
      keepRecentToolResults: 3,
      maxInputTokens: 0,
    });

    expect(manager.compact(messages).compactedToolResults).toBe(0);

    // 下一轮工具调用后，上一轮只保留最近 3 个
    messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: 'next' }] },
      toolMessage(9),
    );
    expect(manager.compact(messages).compactedToolResults).toBe(3);
  });

  it('压缩旧轮次的 tool_call 参数，最近两轮保留原文', () => {
    const bigArgs = JSON.stringify({
      path: 'a.ts',
      content: 'x'.repeat(2000),
    });
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'write_file', arguments: bigArgs },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        name: 'write_file',
        content: 'ok',
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c2',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"b.ts"}' },
          },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c3',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"c.ts"}' },
          },
        ],
      },
    ];
    const manager = new ContextManager({
      keepRecentToolCallRounds: 2,
      keepRecentToolResults: 10,
      maxInputTokens: 0,
    });

    const stats = manager.compact(messages);

    expect(stats.compactedToolCalls).toBe(1);
    const firstCall = (messages[1].tool_calls as any[])[0];
    expect(firstCall.function.arguments).toContain(
      '"_omitted":"context-manager"',
    );
    expect(firstCall.function.arguments.length).toBeLessThan(500);
    // 最近两轮参数保持原样
    expect(
      (messages[3].tool_calls as any[])[0].function.arguments,
    ).toBe('{"path":"b.ts"}');
    // 幂等
    expect(manager.compact(messages).compactedToolCalls).toBe(0);
  });

  it('重复压缩是幂等的', () => {
    const messages = [toolMessage(0), toolMessage(1), toolMessage(2)];
    const manager = new ContextManager({
      keepRecentToolResults: 0,
      maxInputTokens: 0,
    });

    const first = manager.compact(messages);
    const second = manager.compact(messages);

    expect(first.compactedToolResults).toBe(3);
    expect(second.compactedToolResults).toBe(0);
  });

  it('超预算时压缩最近的 tool 结果，但保留最后一个', () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      toolMessage(0, 'a'.repeat(4000)),
      toolMessage(1, 'b'.repeat(4000)),
    ];
    const manager = new ContextManager({
      keepRecentToolResults: 10,
      maxInputTokens: 100,
      toolResultPreviewChars: 60,
    });

    manager.compact(messages);

    expect(messages[2].content).toContain('【已压缩】');
    // 最后一个 tool 结果始终保留全文，供模型做下一步决策
    expect(messages[3].content).toBe('b'.repeat(4000));
  });

  it('不压缩 system、当前 user 和多模态内容', () => {
    const multimodal = [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
    ];
    const messages = [
      { role: 'system', content: 's'.repeat(5000) },
      { role: 'user', content: '旧问题'.repeat(2000) },
      { role: 'user', content: multimodal },
    ];
    const manager = new ContextManager({
      keepRecentToolResults: 0,
      maxInputTokens: 10,
      oldMessagePreviewChars: 100,
    });

    manager.compact(messages);

    expect(messages[0].content).toBe('s'.repeat(5000));
    expect(messages[1].content).toContain('【已压缩】'); // 旧 user 可以压
    expect(messages[2].content).toBe(multimodal); // 当前 user 多模态不动
  });
});
