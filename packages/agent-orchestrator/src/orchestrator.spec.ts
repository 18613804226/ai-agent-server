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

    // 流式 content 保留原始文本（含 think 标签），与旧实现一致
    const contents = events
      .filter((e) => e.type === 'content')
      .map((e) => e.content)
      .join('');
    expect(contents).toBe('<think>想一下</think>你好');

    // 最终回答才清理标签
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect(done?.fullReply).toBe('你好');
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
    expect(handler).toHaveBeenCalledWith({ expression: '1+1' });

    const done = events.at(-1);
    expect(done?.fullReply).toBe('结果是 2');
    // 工具结果已回填到消息序列
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
    // 两次模型调用（工具轮 + 最终轮）
    expect(create).toHaveBeenCalledTimes(2);
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
