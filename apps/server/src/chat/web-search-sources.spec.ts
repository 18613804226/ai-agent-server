/**
 * 联网来源链路测试。
 *
 * characterization 部分锁住阶段 1 之前「不能变」的行为（规则命中 → 结构化
 * sources、工具定义开关、工具结果事件）；后半部分覆盖阶段 1 新增的
 * 「模型主动调用 web_search 也要回流 sources」。
 *
 * 底层用 mock axios.post 同时覆盖后端预检索与工具内检索：两者最终都走
 * 同一个 searchWeb()，不需要 mock 模块边界。
 */
import axios from 'axios';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AgentOrchestrator,
  loadModelCascadeConfig,
  SimpleLock,
} from '@repo/agent-orchestrator';
import { ChatService } from './chat.service.js';
import { ModelClients } from '../agent/model-clients.js';

beforeAll(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.CHAT_DEMO_REPLAY;
  delete process.env.CHAT_SEARCH_SESSION;
});

function streamOf(chunks: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function textStream(text: string) {
  return streamOf([{ choices: [{ delta: { content: text } }] }]);
}

/** 模型第一轮发起一次 web_search，由调用方安排第二轮返回最终正文 */
function toolCallStream(query = 'GLM 最新能力') {
  return streamOf([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_web_1',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: JSON.stringify({ query }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ]);
}

function mkService(create: () => Promise<any>) {
  const prisma = {
    message: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    chatSession: {
      findUnique: vi.fn().mockResolvedValue({ id: 'sess-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    knowledgeFile: { findMany: vi.fn().mockResolvedValue([]) },
    device: {
      findUnique: vi.fn().mockResolvedValue({ preferences: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const vectorService = { searchSimilar: vi.fn().mockResolvedValue([]) };
  const clients = new ModelClients(
    { chat: { completions: { create } } } as never,
    { chat: { completions: { create } } } as never,
  );
  const orchestrator = new AgentOrchestrator({
    getClient: (provider) => clients.getClient(provider),
    modelConfig: loadModelCascadeConfig(),
    showRoutingThought: false,
    rateLimitRetries: 0,
    zhipuLock: new SimpleLock(),
  });
  const service = new ChatService(
    prisma as never,
    vectorService as never,
    orchestrator,
  );
  return { service, prisma, vectorService, create };
}

function mockTavily(
  results: Array<{
    title: string;
    url: string;
    content: string;
    published_date?: string;
  }>,
) {
  return vi.spyOn(axios, 'post').mockResolvedValue({
    data: { results },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: {} },
  } as never);
}

function collector() {
  const events: Array<{ type: string; payload: any }> = [];
  return {
    events,
    onChunk: (type: string, payload: any) => events.push({ type, payload }),
  };
}

const NEWS = [
  { title: '新闻A', url: 'https://a.com/1', content: '摘要A' },
  { title: '新闻B', url: 'https://b.com/2', content: '摘要B' },
];
/** 3 条以上视为「资料充分」，此时工具表会摘掉 web_search */
const ENOUGH = [
  ...NEWS,
  { title: '新闻C', url: 'https://c.com/3', content: '摘要C' },
];

describe('文档整理意图：本地内容处理，不联网', () => {
  it.each(['整理成 word', '润色后整理成 word'])(
    '%s：不预检索、不提供 web_search 工具',
    async (query) => {
      vi.stubEnv('TAVILY_API_KEY', 'test-key');
      vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
      const post = mockTavily(NEWS);
      const create = vi.fn(async (_body?: any) =>
        textStream('```markdown\n# 文档\n```'),
      );
      const { service } = mkService(create);
      const { onChunk } = collector();

      await service.sendMessageStream('sess-1', query, onChunk);

      expect(post).not.toHaveBeenCalled();
      const tools = create.mock.calls[0][0].tools ?? [];
      expect(tools.map((t: any) => t.function.name)).not.toContain(
        'web_search',
      );
    },
  );
});

describe('文档追问：对上一轮文档再加工，不联网', () => {
  it('重点突出…：上一轮回复是文档时，不预检索、不提供 web_search', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    const post = mockTavily(NEWS);
    const create = vi.fn(async (_body?: any) =>
      textStream('```markdown\n# 周报\n```'),
    );
    const { service, prisma } = mkService(create);
    prisma.message.findFirst.mockResolvedValueOnce({
      content: '```markdown\n# 本周工作汇报\n```',
    });
    const { onChunk } = collector();

    await service.sendMessageStream(
      'sess-1',
      '重点突出 钢构智造 App 工作量',
      onChunk,
    );

    expect(post).not.toHaveBeenCalled();
    const tools = create.mock.calls[0][0].tools ?? [];
    expect(tools.map((t: any) => t.function.name)).not.toContain('web_search');
  });
});

describe('联网来源：现状 characterization（阶段 1 不得改变）', () => {
  it('规则命中 + 后端预检索成功：末尾推结构化 web sources 并落库', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    mockTavily(NEWS);
    const create = vi.fn(async () => textStream('今天的新闻有这些。[1][2]'));
    const { service, prisma } = mkService(create);
    const { events, onChunk } = collector();

    const result = await service.sendMessageStream(
      'sess-1',
      '今天的新闻',
      onChunk,
    );

    expect(events.find((e) => e.type === 'sources')?.payload).toEqual([
      {
        kind: 'web',
        index: 1,
        title: '新闻A',
        url: 'https://a.com/1',
        usedInThisReply: true,
      },
      {
        kind: 'web',
        index: 2,
        title: '新闻B',
        url: 'https://b.com/2',
        usedInThisReply: true,
      },
    ]);
    expect(result?.sourcesCount).toBe(2);
    const saved = prisma.message.create.mock.calls.at(-1)?.[0]?.data;
    expect(saved?.sources).toHaveLength(2);
  });

  it('规则命中且预检索充分：只摘掉 web_search，天气/计算器等工具仍可用', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    mockTavily(ENOUGH);
    const create = vi.fn(async (_body?: any) => textStream('新闻摘要 [1]'));
    const { service } = mkService(create);

    await service.sendMessageStream('sess-1', '今天的新闻', () => {});

    const names = create.mock.calls[0][0].tools.map(
      (tool: any) => tool.function.name,
    );
    expect(names).toContain('calculator');
    expect(names).toContain('fetchWeatherInfo');
    expect(names).not.toContain('web_search');
  });

  it('模型主动调 web_search：tool_result 事件照常推出', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    mockTavily(NEWS);
    let round = 0;
    const create = vi.fn(async () =>
      round++ === 0 ? toolCallStream() : textStream('根据资料回答 [1]'),
    );
    const { service } = mkService(create);
    const { events, onChunk } = collector();

    await service.sendMessageStream('sess-1', 'GLM-5.3 现在支持哪些能力', onChunk);

    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('阶段 1：模型主动联网也下发 sources', () => {
  const MORE = [
    { title: '新闻C', url: 'https://c.com/3', content: '摘要C' },
    { title: '新闻D', url: 'https://d.com/4', content: '摘要D' },
  ];
  const response = (results: typeof NEWS) =>
    ({
      data: { results },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: {} },
    }) as never;

  it('模型自己调 web_search：末尾 sources 含结构化 web 来源并落库', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    mockTavily(NEWS);
    let round = 0;
    const create = vi.fn(async () =>
      round++ === 0 ? toolCallStream() : textStream('根据资料回答 [1][2]'),
    );
    const { service, prisma } = mkService(create);
    const { events, onChunk } = collector();

    const result = await service.sendMessageStream(
      'sess-1',
      'GLM-5.3 现在支持哪些能力',
      onChunk,
    );

    expect(events.find((e) => e.type === 'sources')?.payload).toEqual([
      {
        kind: 'web',
        index: 1,
        title: '新闻A',
        url: 'https://a.com/1',
        usedInThisReply: true,
      },
      {
        kind: 'web',
        index: 2,
        title: '新闻B',
        url: 'https://b.com/2',
        usedInThisReply: true,
      },
    ]);
    expect(result?.sourcesCount).toBe(2);
    expect(
      prisma.message.create.mock.calls.at(-1)?.[0]?.data.sources,
    ).toHaveLength(2);
  });

  it('同一轮预检索 + 模型补搜：编号连续、来源合并、工具文本用全局编号', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    vi.spyOn(axios, 'post')
      .mockResolvedValueOnce(response(NEWS))
      .mockResolvedValueOnce(response(MORE));
    let round = 0;
    // 预检索只有 2 条（低于 MIN_WEB_RESULTS），工具表里保留 web_search 供补搜
    const create = vi.fn(async () =>
      round++ === 0
        ? toolCallStream('换个角度查')
        : textStream('综合资料回答 [1][3]'),
    );
    const { service } = mkService(create);
    const { events, onChunk } = collector();

    const result = await service.sendMessageStream(
      'sess-1',
      '今天的新闻',
      onChunk,
    );

    // 正文只写了 [1][3]，来源也只下发这两条，不再把整池 4 条都列出来
    const payload = events.find((e) => e.type === 'sources')?.payload;
    expect(payload.map((s: any) => s.index)).toEqual([1, 3]);
    expect(payload.map((s: any) => s.url)).toEqual([
      'https://a.com/1',
      'https://c.com/3',
    ]);
    expect(result?.sourcesCount).toBe(2);
    expect(
      events.find((e) => e.type === 'tool_result')?.payload.result,
    ).toContain('[3] 新闻C');
  });

  it('CHAT_SEARCH_SESSION=off 一键回退：模型补搜不再下发 web 来源', async () => {
    process.env.CHAT_SEARCH_SESSION = 'off';
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    mockTavily(NEWS);
    let round = 0;
    const create = vi.fn(async () =>
      round++ === 0 ? toolCallStream() : textStream('根据资料回答 [1]'),
    );
    const { service } = mkService(create);
    const { events, onChunk } = collector();

    await service.sendMessageStream(
      'sess-1',
      'GLM-5.3 现在支持哪些能力',
      onChunk,
    );

    const payload = events.find((e) => e.type === 'sources')?.payload;
    expect(payload.filter((s: any) => s.kind === 'web')).toHaveLength(0);
  });

  it('session 不跨请求串号：第二轮普通对话不会带上第一轮的来源', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    mockTavily(NEWS);
    const steps: Array<() => any> = [
      () => toolCallStream(),
      () => textStream('根据资料回答 [1]'),
      () => textStream('你好呀'),
    ];
    let i = 0;
    const create = vi.fn(async () => steps[Math.min(i++, steps.length - 1)]());
    const { service } = mkService(create);

    const first = collector();
    await service.sendMessageStream(
      'sess-1',
      'GLM-5.3 现在支持哪些能力',
      first.onChunk,
    );
    const second = collector();
    await service.sendMessageStream('sess-1', '你好', second.onChunk);

    // 正文只写了 [1]，来源也只下发这一条；未引用的不再列出来
    expect(
      first.events.find((e) => e.type === 'sources')?.payload,
    ).toHaveLength(1);
    expect(
      second.events.find((e) => e.type === 'sources')?.payload,
    ).toHaveLength(0);
  });
});

describe('本轮搜索策略：引用规则 / 失败语义 / 工具表 / 引用标记', () => {
  const systemPromptOf = (create: any) =>
    create.mock.calls[0][0].messages[0].content as string;
  const toolNamesOf = (create: any) =>
    (create.mock.calls[0][0].tools as any[]).map((t) => t.function.name);

  it('工具结果只有数据：不再把「引用请用 [序号]」这类内部指令拼进去', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    mockTavily(NEWS);
    let round = 0;
    const create = vi.fn(async () =>
      round++ === 0 ? toolCallStream() : textStream('根据资料回答 [1]'),
    );
    const { service } = mkService(create);
    const { events, onChunk } = collector();

    await service.sendMessageStream(
      'sess-1',
      'GLM-5.3 现在支持哪些能力',
      onChunk,
    );

    const result = events.find((e) => e.type === 'tool_result')?.payload
      .result as string;
    expect(result).toContain('[1] 新闻A');
    expect(result).not.toContain('引用请用');
    expect(result).not.toContain('禁止把裸 URL');
    expect(result).not.toContain('URL 仅用于生成来源链接');
  });

  it('预检索服务失败：prompt 说明「服务不可用」并带上检索词，不再谎称未搜', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const create = vi.fn(async (_body?: any) => textStream('暂无法查证。'));
    const { service } = mkService(create);

    await service.sendMessageStream('sess-1', '今天的新闻', () => {});

    const system = systemPromptOf(create);
    expect(system).not.toContain('本轮未执行联网搜索。');
    expect(system).toContain('联网检索服务暂时不可用');
    expect(system).toContain('检索词「今天的新闻」');
    expect(toolNamesOf(create)).toContain('web_search');
  });

  it('预检索 0 条结果：区分「没搜到」，并保留 web_search 让模型换词', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    mockTavily([]);
    const create = vi.fn(async (_body?: any) => textStream('没有查到。'));
    const { service } = mkService(create);

    await service.sendMessageStream('sess-1', '今天的新闻', () => {});

    const system = systemPromptOf(create);
    expect(system).toContain('没有找到可用资料');
    expect(system).toContain('可换一个更具体的检索词');
    expect(system).not.toContain('本轮未执行联网搜索。');
    expect(toolNamesOf(create)).toContain('web_search');
  });

  it('规则未命中：web_search 仍在工具表里，模型可自行决定联网', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    const create = vi.fn(async (_body?: any) => textStream('你好呀'));
    const { service } = mkService(create);

    await service.sendMessageStream('sess-1', '你好', () => {});

    expect(toolNamesOf(create)).toContain('web_search');
    expect(systemPromptOf(create)).toContain('本轮未执行联网搜索。');
  });

  it('只下发正文引用过的 [n] 来源，未引用的不再列出来', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    mockTavily(NEWS);
    const create = vi.fn(async () => textStream('只引用了第一条 [1]'));
    const { service } = mkService(create);
    const { events, onChunk } = collector();

    await service.sendMessageStream('sess-1', '今天的新闻', onChunk);

    const payload = events.find((e) => e.type === 'sources')?.payload;
    expect(payload).toHaveLength(1);
    expect(payload[0].index).toBe(1);
    expect(payload.map((s: any) => s.usedInThisReply)).toEqual([true]);
  });

  it('正文没有 [n] 角标：联网来源不下发、不落库、计数为 0', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    mockTavily(NEWS);
    // 预检索有结果，但模型用工具数据作答、一个角标都没写（截图里的天气回答）
    const create = vi.fn(async () => textStream('北京现在 4℃，出门多穿点。'));
    const { service, prisma } = mkService(create);
    const { events, onChunk } = collector();

    const result = await service.sendMessageStream(
      'sess-1',
      '今天的新闻',
      onChunk,
    );

    expect(events.find((e) => e.type === 'sources')?.payload).toEqual([]);
    expect(result?.sourcesCount).toBe(0);
    const saved = prisma.message.create.mock.calls.at(-1)?.[0]?.data;
    expect(saved?.sources).toEqual([]);
  });
});
