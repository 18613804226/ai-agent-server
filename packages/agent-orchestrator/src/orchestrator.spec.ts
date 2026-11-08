import { describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator, type OrchestratorConfig } from './orchestrator.js';
import { loadModelCascadeConfig } from './model-cascade.js';
import { SimpleLock } from './simple-lock.js';
import type { AgentEvent, ContentGate, RegisteredTool } from './types.js';
import type OpenAI from 'openai';

/** 造一个假 OpenAI 客户端：每次 create 依次返回预置的 chunk 序列 */
function fakeClient(chunkSets: any[][]): { client: OpenAI; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => {
    const chunks = chunkSets.shift() ?? [];
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  });
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

function config(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    getClient: () => null,
    modelConfig: loadModelCascadeConfig(),
    showRoutingThought: false,
    rateLimitRetries: 0,
    zhipuLock: new SimpleLock(),
    ...overrides,
  };
}

const dashscope = (model: string) => ({ provider: 'dashscope' as const, model });

async function collect(
  orchestrator: AgentOrchestrator,
  input: Parameters<AgentOrchestrator['run']>[0],
  gate?: ContentGate,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of orchestrator.run(input, gate)) events.push(ev);
  return events;
}

describe('AgentOrchestrator.run', () => {
  it('纯对话：吐 content 后以 done 收尾，并清理 think 标签', async () => {
    const { client } = fakeClient([
      [{ choices: [{ delta: { content: '<think>想一下</think>你好' } }] }],
    ]);
    const orch = new AgentOrchestrator(
      config({ getClient: () => client }),
    );

    const events = await collect(orch, {
      messages: [],
      candidates: [dashscope('qwen')],
    });

    // 流式 content 也剥掉 think 标签，用户看不到推理伪工具块
    const contents = events
      .filter((e) => e.type === 'content')
      .map((e) => e.content)
      .join('');
    expect(contents).toBe('你好');

    // 最终回答同样不含标签
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect(done?.fullReply).toBe('你好');
  });

  it('采样参数只下发给智谱候选，qwen 与不传时保持服务端默认', async () => {
    const chunks = [{ choices: [{ delta: { content: 'ok' } }] }];
    const zhipu = fakeClient([chunks]);
    await collect(
      new AgentOrchestrator(config({ getClient: () => zhipu.client })),
      {
        messages: [],
        candidates: [{ provider: 'zhipu', model: 'glm-4.5-flash' }],
        sampling: { temperature: 0.7, top_p: 0.8 },
      },
    );
    expect(zhipu.create.mock.calls[0][0]).toMatchObject({
      temperature: 0.7,
      top_p: 0.8,
    });

    const dash = fakeClient([[...chunks]]);
    await collect(
      new AgentOrchestrator(config({ getClient: () => dash.client })),
      {
        messages: [],
        candidates: [dashscope('qwen')],
        sampling: { temperature: 0.7, top_p: 0.8 },
      },
    );
    expect(dash.create.mock.calls[0][0].temperature).toBeUndefined();
    expect(dash.create.mock.calls[0][0].top_p).toBeUndefined();

    const plain = fakeClient([[...chunks]]);
    await collect(
      new AgentOrchestrator(config({ getClient: () => plain.client })),
      {
        messages: [],
        candidates: [{ provider: 'zhipu', model: 'glm-4.5-flash' }],
      },
    );
    expect(plain.create.mock.calls[0][0].temperature).toBeUndefined();
  });

  it('宿主注入 max_tokens 时只下发给智谱候选', async () => {
    const chunks = [{ choices: [{ delta: { content: 'ok' } }] }];
    const sampling = { temperature: 0.85, top_p: 0.9, max_tokens: 200 };

    const zhipu = fakeClient([chunks]);
    await collect(
      new AgentOrchestrator(config({ getClient: () => zhipu.client })),
      {
        messages: [],
        candidates: [{ provider: 'zhipu', model: 'glm-4.5-flash' }],
        sampling,
      },
    );
    expect(zhipu.create.mock.calls[0][0]).toMatchObject({
      temperature: 0.85,
      top_p: 0.9,
      max_tokens: 200,
    });

    const dash = fakeClient([[...chunks]]);
    await collect(
      new AgentOrchestrator(config({ getClient: () => dash.client })),
      { messages: [], candidates: [dashscope('qwen')], sampling },
    );
    expect(dash.create.mock.calls[0][0].max_tokens).toBeUndefined();
  });

  it('工具调用：先 tool_call/tool_result，再跑下一轮出最终回答', async () => {
    const toolDelta = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'calculator', arguments: '{"expression":"1+1"}' },
              },
            ],
          },
        },
      ],
    };
    const { client, create } = fakeClient([
      [toolDelta],
      [{ choices: [{ delta: { content: '结果是 2' } }] }],
    ]);
    const handler = vi.fn(
      (args: Record<string, unknown>) => `计算结果：${String(args.expression)}`,
    );
    const tools: RegisteredTool[] = [
      {
        definition: {
          type: 'function',
          function: {
            name: 'calculator',
            description: '计算器',
            parameters: { type: 'object', properties: {} },
          },
        },
        handler,
      },
    ];
    const orch = new AgentOrchestrator(
      config({ getClient: () => client }),
    );

    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: '1+1=?' },
    ];
    const events = await collect(orch, {
      messages,
      tools,
      candidates: [dashscope('qwen')],
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');

    const result = events.find((e) => e.type === 'tool_result');
    expect(result?.name).toBe('calculator');
    expect(result?.result).toBe('计算结果：1+1');
    expect(handler).toHaveBeenCalledWith(
      { expression: '1+1' },
      { signal: undefined, toolName: 'calculator', artifacts: expect.anything() },
    );

    const done = events.at(-1);
    expect(done?.fullReply).toBe('结果是 2');
    // 工具结果已回填到消息序列
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
    // 两次模型调用（工具轮 + 最终轮）
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('多轮工具调用：tool_call / tool_result 序号跨轮唯一', async () => {
    const toolDelta = (id: string) => ({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name: 'calculator', arguments: '{}' },
              },
            ],
          },
        },
      ],
    });
    // 两轮各调一次工具（模型侧 delta.index 都从 0 开始），最后一轮出答案
    const { client, create } = fakeClient([
      [toolDelta('call_1')],
      [toolDelta('call_2')],
      [{ choices: [{ delta: { content: '完成' } }] }],
    ]);
    const tools: RegisteredTool[] = [
      {
        definition: {
          type: 'function',
          function: {
            name: 'calculator',
            description: '计算器',
            parameters: { type: 'object', properties: {} },
          },
        },
        handler: () => 'ok',
      },
    ];
    const orch = new AgentOrchestrator(
      config({ getClient: () => client }),
    );

    const events = await collect(orch, {
      messages: [],
      tools,
      candidates: [dashscope('qwen')],
    });

    const calls = events.filter((e) => e.type === 'tool_call');
    const results = events.filter((e) => e.type === 'tool_result');
    // 序号跨轮递增，而不是每轮都从 0 重来
    expect(calls.map((e) => e.index)).toEqual([0, 1]);
    expect(results.map((e) => e.index)).toEqual([0, 1]);
    // 每个 result 都唯一对应一个 call，UI 才不会互相覆盖
    for (const r of results) {
      expect(calls.filter((c) => c.index === r.index)).toHaveLength(1);
    }
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('拒答守卫：glm 拒答 → 换 qwen 重试，用户看不到拒答', async () => {
    const { client: zhipu } = fakeClient([
      [{ choices: [{ delta: { content: '很抱歉，我无法直接访问或阅读您上传的附件内容。' } }] }],
    ]);
    const { client: qwen, create: qwenCreate } = fakeClient([
      [{ choices: [{ delta: { content: '文档内容只包含一个单词 test。' } }] }],
    ]);
    const orch = new AgentOrchestrator(
      config({
        getClient: (p) => (p === 'zhipu' ? zhipu : qwen),
      }),
    );
    const gate: ContentGate = {
      enabled: true,
      // 阈值必须大于拒答文本长度，否则内容会先被放行，守卫就来不及生效
      threshold: 120,
      isRefusal: (t) => t.includes('无法直接访问'),
      nextCandidates: (cur) => cur.filter((c) => c.provider !== 'zhipu'),
    };

    const events = await collect(
      orch,
      {
        messages: [],
        candidates: [
          { provider: 'zhipu', model: 'glm-4-flash' },
          dashscope('qwen'),
        ],
      },
      gate,
    );

    const contents = events
      .filter((e) => e.type === 'content')
      .map((e) => e.content)
      .join('');
    expect(contents).toBe('文档内容只包含一个单词 test。');
    expect(qwenCreate).toHaveBeenCalledTimes(1);
  });

  it('候选降级：首个候选建流失败 → 自动切下一个', async () => {
    let calls = 0;
    const create = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('boom'), { status: 500 });
      return (async function* () {
        yield { choices: [{ delta: { content: '降级成功' } }] };
      })();
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const orch = new AgentOrchestrator(
      config({ getClient: () => client }),
    );

    const events = await collect(orch, {
      messages: [],
      candidates: [dashscope('qwen-a'), dashscope('qwen-b')],
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.fullReply).toBe('降级成功');
  });

  it('没有候选：吐 error 事件', async () => {
    const orch = new AgentOrchestrator(config());
    const events = await collect(orch, { messages: [], candidates: [] });
    expect(events[0]?.type).toBe('error');
  });

  it('候选存在但 provider 未配置：抛出明确错误而不是 null', async () => {
    const orch = new AgentOrchestrator(config({ getClient: () => null }));
    await expect(
      collect(orch, { messages: [], candidates: [dashscope('qwen')] }),
    ).rejects.toThrow('没有可用的模型客户端');
  });

  it('finish_reason=length：done 标记回答被截断', async () => {
    const { client } = fakeClient([
      [
        { choices: [{ delta: { content: '半截回答' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ],
    ]);
    const orch = new AgentOrchestrator(config({ getClient: () => client }));

    const events = await collect(orch, {
      messages: [],
      candidates: [dashscope('qwen')],
    });
    const done = events.at(-1);

    expect(done?.finishReason).toBe('length');
    expect(done?.truncated).toBe(true);
    expect(done?.fullReply).toBe('半截回答');
  });

  it('建连超时：降级到下一个候选', async () => {
    let calls = 0;
    const create = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return (async function* () {
        yield { choices: [{ delta: { content: '超时后降级成功' } }] };
      })();
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const orch = new AgentOrchestrator(
      config({ getClient: () => client, connectTimeoutMs: 20 }),
    );

    const events = await collect(orch, {
      messages: [],
      candidates: [dashscope('qwen-a'), dashscope('qwen-b')],
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.fullReply).toBe('超时后降级成功');
  });

  it('流空闲超时：中断而不是永久挂起', async () => {
    const create = vi.fn(async () => {
      return (async function* () {
        yield { choices: [{ delta: { content: '部分' } }] };
        await new Promise(() => {});
      })();
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const orch = new AgentOrchestrator(
      config({ getClient: () => client, streamIdleTimeoutMs: 20 }),
    );

    await expect(
      collect(orch, { messages: [], candidates: [dashscope('qwen')] }),
    ).rejects.toThrow('空闲超时');
  });

  it('智谱锁等待超时：降级到下一个候选', async () => {
    const lock = new SimpleLock();
    const release = await lock.acquire();
    const { client: qwen } = fakeClient([
      [{ choices: [{ delta: { content: '锁超时后走 qwen' } }] }],
    ]);
    const orch = new AgentOrchestrator(
      config({
        getClient: (provider) => (provider === 'zhipu' ? qwen : qwen),
        zhipuLock: lock,
        lockAcquireTimeoutMs: 20,
      }),
    );

    try {
      const events = await collect(orch, {
        messages: [],
        candidates: [
          { provider: 'zhipu', model: 'glm-4-flash' },
          dashscope('qwen'),
        ],
      });
      expect(events.at(-1)?.fullReply).toBe('锁超时后走 qwen');
    } finally {
      release();
    }
  });

  it('401 属于配置错误：不降级，直接失败', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const orch = new AgentOrchestrator(
      config({ getClient: () => client }),
    );

    await expect(
      collect(orch, {
        messages: [],
        candidates: [dashscope('qwen-a'), dashscope('qwen-b')],
      }),
    ).rejects.toThrow('unauthorized');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('工具执行超时：返回超时文本并继续下一轮', async () => {
    const toolDelta = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'slow_tool',
                  arguments: '{"value":"x"}',
                },
              },
            ],
          },
        },
      ],
    };
    const { client } = fakeClient([
      [toolDelta],
      [{ choices: [{ delta: { content: '已跳过慢工具' } }] }],
    ]);
    const tools: RegisteredTool[] = [
      {
        definition: {
          type: 'function',
          function: {
            name: 'slow_tool',
            description: '慢工具',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          },
        },
        handler: () => new Promise(() => {}),
      },
    ];
    const orch = new AgentOrchestrator(
      config({ getClient: () => client, toolTimeoutMs: 20 }),
    );

    const events = await collect(orch, {
      messages: [],
      tools,
      candidates: [dashscope('qwen')],
    });

    const result = events.find((e) => e.type === 'tool_result');
    expect(result?.result).toContain('执行超时');
    expect(events.at(-1)?.fullReply).toBe('已跳过慢工具');
  });

  it('多轮工具调用会压缩旧工具结果，避免全文反复重发', async () => {
    const toolDelta = (id: string) => ({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"a.ts"}',
                },
              },
            ],
          },
        },
      ],
    });
    const seen: any[][] = [];
    const create = vi.fn(async (body: any) => {
      seen.push(body.messages.map((m: any) => ({ ...m })));
      const round = seen.length;
      const chunks =
        round === 1
          ? [toolDelta('call_1')]
          : round === 2
            ? [toolDelta('call_2')]
            : [{ choices: [{ delta: { content: '完成' } }] }];
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const tools: RegisteredTool[] = [
      {
        definition: {
          type: 'function',
          function: {
            name: 'read_file',
            description: '读文件',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        },
        handler: () => 'x'.repeat(2000),
      },
    ];
    const orch = new AgentOrchestrator(
      config({
        getClient: () => client,
        contextOptions: { keepRecentToolResults: 1 },
      }),
    );

    const events = await collect(orch, {
      messages: [],
      tools,
      candidates: [dashscope('qwen')],
      maxToolRounds: 2,
    });

    const lastMessages = seen.at(-1)!;
    const toolMessages = lastMessages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    // 第一轮的工具结果已被压缩，第二轮仍保留全文
    expect(toolMessages[0].content).toContain('【已压缩】');
    expect(toolMessages[1].content).toBe('x'.repeat(2000));

    const done = events.at(-1);
    expect(done?.context?.compactedToolResults).toBeGreaterThanOrEqual(1);
  });

  it('自动验证：编辑工具执行后回填验证结果，驱动修复', async () => {
    const toolDelta = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'edit_file',
                  arguments: '{"path":"a.ts","old_string":"x","new_string":"y"}',
                },
              },
            ],
          },
        },
      ],
    };
    const seen: any[][] = [];
    const create = vi.fn(async (body: any) => {
      seen.push(body.messages.map((m: any) => ({ ...m })));
      const chunks =
        seen.length === 1
          ? [toolDelta]
          : [{ choices: [{ delta: { content: '已根据验证修复' } }] }];
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const tools: RegisteredTool[] = [
      {
        definition: {
          type: 'function',
          function: {
            name: 'edit_file',
            description: '编辑文件',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        },
        handler: () => '已修改',
      },
    ];
    const verify = vi.fn(async () => '❌ lint 失败：a.ts(1,1)');

    const orch = new AgentOrchestrator(config({ getClient: () => client }));
    const events = await collect(orch, {
      messages: [],
      tools,
      candidates: [dashscope('qwen')],
      maxToolRounds: 2,
      verifyAfterTools: verify,
    });

    expect(verify).toHaveBeenCalledWith({
      toolNames: ['edit_file'],
      signal: undefined,
    });
    const lastMessages = seen.at(-1)!;
    const verifyMsg = lastMessages.find((m) =>
      String(m.content ?? '').includes('【自动验证】'),
    );
    expect(verifyMsg).toBeDefined();
    expect(verifyMsg.content).toContain('lint 失败');
    expect(events.at(-1)?.fullReply).toBe('已根据验证修复');
  });

  it('自动验证：只读工具不触发验证，返回 null 也不回填', async () => {
    const toolDelta = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"a.ts"}',
                },
              },
            ],
          },
        },
      ],
    };
    const { client } = fakeClient([
      [toolDelta],
      [{ choices: [{ delta: { content: '读完了' } }] }],
    ]);
    const tools: RegisteredTool[] = [
      {
        definition: {
          type: 'function',
          function: {
            name: 'read_file',
            description: '读文件',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        },
        handler: () => '内容',
      },
    ];
    const verify = vi.fn(async () => null);
    const orch = new AgentOrchestrator(config({ getClient: () => client }));

    await collect(orch, {
      messages: [],
      tools,
      candidates: [dashscope('qwen')],
      verifyAfterTools: verify,
    });

    expect(verify).not.toHaveBeenCalled();
  });

  it('审批策略：deny 直接拒绝且不执行 handler', async () => {
    const toolDelta = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: '{"path":"a.ts","content":"x"}',
                },
              },
            ],
          },
        },
      ],
    };
    const { client } = fakeClient([
      [toolDelta],
      [{ choices: [{ delta: { content: '完成' } }] }],
    ]);
    const handler = vi.fn(() => '写入成功');
    const tools: RegisteredTool[] = [
      {
        definition: {
          type: 'function',
          function: {
            name: 'write_file',
            description: '写文件',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        },
        handler,
      },
    ];
    const orch = new AgentOrchestrator(config({ getClient: () => client }));

    const events = await collect(orch, {
      messages: [],
      tools,
      candidates: [dashscope('qwen')],
      approvalPolicy: () => 'deny',
    });

    expect(handler).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result');
    expect(result?.result).toContain('策略拒绝');
  });

  it('审批策略：ask + 拒绝时不执行；ask + 允许时执行', async () => {
    const toolDelta = (id: string) => ({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: {
                  name: 'run_terminal',
                  arguments: '{"command":"ls"}',
                },
              },
            ],
          },
        },
      ],
    });

    const runCase = async (approved: boolean) => {
      const { client } = fakeClient([
        [toolDelta('c1')],
        [{ choices: [{ delta: { content: 'ok' } }] }],
      ]);
      const handler = vi.fn(() => '命令输出');
      const tools: RegisteredTool[] = [
        {
          definition: {
            type: 'function',
            function: {
              name: 'run_terminal',
              description: '终端',
              parameters: {
                type: 'object',
                properties: { command: { type: 'string' } },
                required: ['command'],
              },
            },
          },
          handler,
        },
      ];
      const approve = vi.fn(async () => approved);
      const orch = new AgentOrchestrator(config({ getClient: () => client }));
      const events = await collect(orch, {
        messages: [],
        tools,
        candidates: [dashscope('qwen')],
        approvalPolicy: () => 'ask',
        requestApproval: approve,
      });
      return { handler, approve, events };
    };

    const denied = await runCase(false);
    expect(denied.approve).toHaveBeenCalledTimes(1);
    expect(denied.handler).not.toHaveBeenCalled();
    expect(denied.events.find((e) => e.type === 'tool_result')?.result).toContain(
      '用户拒绝执行',
    );

    const allowed = await runCase(true);
    expect(allowed.handler).toHaveBeenCalledTimes(1);
    expect(
      allowed.events.find((e) => e.type === 'tool_result')?.result,
    ).toBe('命令输出');
  });

  it('只读工具并行执行', async () => {
    const delta = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"a.ts"}',
                },
              },
              {
                index: 1,
                id: 'c2',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"b.ts"}',
                },
              },
            ],
          },
        },
      ],
    };
    const { client } = fakeClient([
      [delta],
      [{ choices: [{ delta: { content: 'ok' } }] }],
    ]);
    let secondStarted = false;
    const handler = vi.fn(async (args: any) => {
      if (args.path === 'a.ts') {
        // 串行执行时第二个不会启动，这里会一直等 → 测试超时
        while (!secondStarted) await new Promise((r) => setTimeout(r, 5));
        return 'a';
      }
      secondStarted = true;
      return 'b';
    });
    const tools: RegisteredTool[] = [
      {
        definition: {
          type: 'function',
          function: {
            name: 'read_file',
            description: '读文件',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        },
        handler,
        readOnly: true,
      },
    ];
    const orch = new AgentOrchestrator(config({ getClient: () => client }));
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('只读工具未并行执行')), 1000),
    );
    await expect(
      Promise.race([
        collect(orch, {
          messages: [],
          tools,
          candidates: [dashscope('qwen')],
          maxToolRounds: 1,
        }),
        timeout,
      ]),
    ).resolves.toBeDefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('只读工具重复调用返回引用，不重复执行', async () => {
    const toolDelta = (id: string) => ({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"a.ts"}',
                },
              },
            ],
          },
        },
      ],
    });
    const { client } = fakeClient([
      [toolDelta('c1')],
      [toolDelta('c2')],
      [{ choices: [{ delta: { content: 'done' } }] }],
    ]);
    const handler = vi.fn(async () => 'file content');
    const tools: RegisteredTool[] = [
      {
        definition: {
          type: 'function',
          function: {
            name: 'read_file',
            description: '读文件',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        },
        handler,
        readOnly: true,
      },
    ];
    const orch = new AgentOrchestrator(config({ getClient: () => client }));
    const events = await collect(orch, {
      messages: [],
      tools,
      candidates: [dashscope('qwen')],
      maxToolRounds: 2,
    });
    const results = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => e.result);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(results[1]).toContain('重复调用');
  });

  it('客户端中断：收到信号后停止产出', async () => {
    const controller = new AbortController();
    const { client } = fakeClient([
      [{ choices: [{ delta: { content: 'partial' } }] }],
    ]);
    const orch = new AgentOrchestrator(
      config({ getClient: () => client }),
    );
    controller.abort();

    const events = await collect(
      orch,
      { messages: [], candidates: [dashscope('qwen')], signal: controller.signal },
    );
    expect(events.length).toBe(0);
  });
});
