/**
 * 离线回放：预录数据 + ChatService 集成（强制模式 / 上游失败兜底）。
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  AgentOrchestrator,
  loadModelCascadeConfig,
  SimpleLock,
} from '@repo/agent-orchestrator';
import { ChatService } from './chat.service.js';
import { ModelClients } from '../agent/model-clients.js';
import {
  DEMO_FALLBACK,
  demoQuestions,
  demoReplayEvents,
  demoReplayMode,
  findDemoReplay,
} from './demo-replay.js';

beforeAll(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
});

beforeEach(() => {
  // 兜底用例本来就会打错误/切换日志，抑制掉避免污染测试输出
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.CHAT_DEMO_REPLAY;
  delete process.env.CHAT_MAX_INPUT_TOKENS;
  vi.restoreAllMocks();
});

function streamOf(text: string) {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
  })();
}

function mkService(
  create: () => Promise<any>,
  showRoutingThought = false,
) {
  const prisma = {
    message: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
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
    showRoutingThought,
    rateLimitRetries: 0,
    zhipuLock: new SimpleLock(),
  });
  const service = new ChatService(
    prisma as never,
    vectorService as never,
    orchestrator,
  );
  return { service, prisma, vectorService };
}

describe('离线回放：预录数据', () => {
  it('开关三态：默认只兜底，true 强制，off 完全关闭', () => {
    expect(demoReplayMode()).toBe('fallback');
    process.env.CHAT_DEMO_REPLAY = 'true';
    expect(demoReplayMode()).toBe('forced');
    process.env.CHAT_DEMO_REPLAY = 'off';
    expect(demoReplayMode()).toBe('off');
  });

  it('按关键词命中场景，越具体的排越前', () => {
    expect(findDemoReplay('北京今天天气怎么样？')?.label).toBe('工具调用（天气）');
    expect(findDemoReplay('你好，今天天气怎么样')?.label).toBe('工具调用（天气）');
    expect(findDemoReplay('帮我总结一下知识库文档')?.label).toBe(
      '知识库 RAG + 来源标注',
    );
    expect(findDemoReplay('随便问点别的')).toBeUndefined();
  });

  it('演示问题清单覆盖五类场景', () => {
    const questions = demoQuestions();
    expect(questions).toHaveLength(5);
    expect(questions.every((q) => q.question && q.label)).toBe(true);
  });

  it('事件序列保留工具链，content 分块拼回完整回答', () => {
    const entry = findDemoReplay('北京天气')!;
    const events = demoReplayEvents(entry);
    expect(events.some(([type]) => type === 'tool_call')).toBe(true);
    expect(events.some(([type]) => type === 'tool_result')).toBe(true);
    const thoughts = events
      .filter((event): event is ['thought', string] => event[0] === 'thought')
      .map(([, payload]) => payload);
    expect(thoughts).toContain('🔧 调用 fetchWeatherInfo');
    expect(thoughts.some((t) => t.startsWith('↩️ fetchWeatherInfo：'))).toBe(
      true,
    );
    const callTextAt = events.findIndex(
      ([type, payload]) =>
        type === 'thought' && payload === '🔧 调用 fetchWeatherInfo',
    );
    expect(callTextAt).toBeGreaterThanOrEqual(0);
    expect(callTextAt).toBeLessThan(
      events.findIndex(([type]) => type === 'tool_call'),
    );
    expect(
      events
        .filter((event): event is ['content', string] => event[0] === 'content')
        .map(([, payload]) => payload)
        .join(''),
    ).toBe(entry.reply);
  });

  it('通用兜底不编造事实、链接或来源', () => {
    expect(DEMO_FALLBACK.reply).toContain('演示回放');
    expect(DEMO_FALLBACK.reply).not.toMatch(/https?:\/\//);
    expect(DEMO_FALLBACK.sources).toHaveLength(0);
  });
});

describe('离线回放：ChatService 集成', () => {
  it('强制模式完全不请求模型，照常推工具链与正文', async () => {
    process.env.CHAT_DEMO_REPLAY = 'true';
    const create = vi.fn(async () => streamOf('不应调用模型'));
    const { service, prisma } = mkService(create);
    const events: Array<{ type: string; payload: any }> = [];

    const result = await service.sendMessageStream(
      'sess-1',
      '北京今天天气怎么样？',
      (type, payload) => events.push({ type, payload }),
    );

    expect(create).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === 'thought' &&
          String(e.payload).includes('🔧 调用 fetchWeatherInfo'),
      ),
    ).toBe(true);
    expect(
      events
        .filter((e) => e.type === 'content')
        .map((e) => e.payload)
        .join(''),
    ).toBe(findDemoReplay('北京天气')!.reply);
    expect(result?.model).toBe('demo-replay');
    expect(prisma.message.create).toHaveBeenCalledTimes(2);
  });

  it('模型请求失败时自动兜底回放，不向用户推 error', async () => {
    const create = vi.fn(async () => {
      throw new Error('所有模型候选均请求失败');
    });
    const { service } = mkService(create);
    const events: Array<{ type: string; payload: any }> = [];

    // 用非实时问题，确保失败来自模型而不是联网检索配置
    const result = await service.sendMessageStream(
      'sess-1',
      '刚才那点能再说清楚一点吗？',
      (type, payload) => events.push({ type, payload }),
    );

    expect(create).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      events.some(
        (e) => e.type === 'thought' && String(e.payload).includes('演示回放'),
      ),
    ).toBe(true);
    expect(
      events
        .filter((e) => e.type === 'content')
        .map((e) => e.payload)
        .join(''),
    ).toBe(findDemoReplay('刚才')!.reply);
    expect(result?.model).toBe('demo-replay');
  });

  it('显式 off 时不回放，恢复原来的错误帧', async () => {
    process.env.CHAT_DEMO_REPLAY = 'off';
    const create = vi.fn(async () => {
      throw new Error('所有模型候选均请求失败');
    });
    const { service } = mkService(create);
    const events: Array<{ type: string; payload: any }> = [];

    await expect(
      service.sendMessageStream(
        'sess-1',
        '刚才那点能再说清楚一点吗？',
        (type, payload) => events.push({ type, payload }),
      ),
    ).rejects.toThrow();

    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'content')).toBe(false);
  });
});

describe('联网检索失败自动降级（P0）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('联网 API 失败不拖垮整轮：推提示帧、照常请求模型、不触发离线回放', async () => {
    // 让 searchWeb 必然失败；同时关掉回放，避免把「降级」误判成「回放兜底」
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'tavily');
    vi.stubEnv('TAVILY_API_KEY', '');
    process.env.CHAT_DEMO_REPLAY = 'off';
    const create = vi.fn(async () => streamOf('暂未查到，我如实说明。'));
    const { service } = mkService(create);
    const events: Array<{ type: string; payload: any }> = [];

    const result = await service.sendMessageStream(
      'sess-1',
      '今天的新闻',
      (type, payload) => events.push({ type, payload }),
    );

    expect(create).toHaveBeenCalled();
    expect(result?.model).not.toBe('demo-replay');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === 'thought' &&
          String(e.payload).includes('联网检索暂不可用'),
      ),
    ).toBe(true);
    expect(
      events
        .filter((e) => e.type === 'content')
        .map((e) => e.payload)
        .join(''),
    ).toContain('暂未查到');
  });
});

describe('APP 端模型路由决策展示', () => {
  it('platform=ios 时同样推「模型选择：…」给前端思考流', async () => {
    const create = vi.fn(async () => streamOf('你好'));
    const { service } = mkService(create, true);
    const events: Array<{ type: string; payload: any }> = [];

    await service.sendMessageStream(
      'sess-1',
      '你好',
      (type, payload) => events.push({ type, payload }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'ios',
    );

    expect(
      events.some(
        (e) =>
          e.type === 'thought' && String(e.payload).includes('模型选择：'),
      ),
    ).toBe(true);
  });
});

describe('上下文记忆：滚动摘要与可观测指标', () => {
  it('长历史被预算裁掉时启用摘要，并回报记忆指标', async () => {
    const create = vi.fn(async () => streamOf('好的'));
    const { service, prisma } = mkService(create);
    const longHistory = Array.from({ length: 40 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content:
        i === 0
          ? '以后温度都用摄氏度，别用华氏度'
          : `第 ${i} 轮聊过的内容`.repeat(30),
      images: null,
      sources: null,
    }));
    prisma.message.findMany.mockResolvedValue(longHistory);

    const result = await service.sendMessageStream(
      'sess-1',
      '你好',
      () => {},
    );

    expect(result?.historyKept).toBeGreaterThan(0);
    expect(result?.historyDropped).toBeGreaterThan(0);
    expect(result?.digestUsed).toBe(true);
  });
});

describe('上下文记忆：RAG 追问缓存与预算同源', () => {
  const longHistory = Array.from({ length: 40 }, (_, i) => ({
    id: `m-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${i} 轮聊过的内容`.repeat(30),
    images: null,
    sources: null,
  }));

  it('指代类追问复用上一轮 RAG 结果，不重复检索', async () => {
    const create = vi.fn(async () => streamOf('好的'));
    const { service, vectorService } = mkService(create);
    vectorService.searchSimilar.mockResolvedValue([
      {
        similarity: 0.9,
        content: '资料内容',
        metadata: { fileId: 'f1', fileName: 'a.pdf' },
      },
    ]);

    await service.sendMessageStream(
      'sess-1',
      '帮我总结一下知识库文档',
      () => {},
    );
    expect(vectorService.searchSimilar).toHaveBeenCalledTimes(1);

    const thoughts: string[] = [];
    await service.sendMessageStream(
      'sess-1',
      '刚才那点再说清楚一点',
      (type, payload) => {
        if (type === 'thought' && typeof payload === 'string') {
          thoughts.push(payload);
        }
      },
    );
    expect(vectorService.searchSimilar).toHaveBeenCalledTimes(1);
    expect(thoughts).toContain('📚 沿用上一轮检索到的知识库资料。');
  });

  it('CHAT_MAX_INPUT_TOKENS 调小后保留的历史条数随之下降', async () => {
    const create = vi.fn(async () => streamOf('好的'));
    const { service, prisma } = mkService(create);
    prisma.message.findMany.mockResolvedValue(longHistory);

    const normal = await service.sendMessageStream('sess-1', '你好', () => {});
    process.env.CHAT_MAX_INPUT_TOKENS = '1200';
    const smaller = await service.sendMessageStream(
      'sess-1',
      '你好',
      () => {},
    );

    expect(normal?.historyKept).toBeGreaterThan(0);
    expect(smaller?.historyKept).toBeLessThan(normal!.historyKept);
  });
});

describe('用户画像：显式声明即记录', () => {
  it('用户显式说「记住…」时记录偏好并推提示帧', async () => {
    const create = vi.fn(async () => streamOf('好的'));
    const { service, prisma } = mkService(create);
    const thoughts: string[] = [];

    await service.sendMessageStream(
      'sess-1',
      '记住：以后回答用要点式',
      (type, payload) => {
        if (type === 'thought' && typeof payload === 'string') {
          thoughts.push(payload);
        }
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'dev-1',
    );

    expect(thoughts).toContain('🧠 已记住偏好：输出格式=要点式');
    expect(prisma.device.update).toHaveBeenCalled();
  });

  it('普通闲聊不会写画像', async () => {
    const create = vi.fn(async () => streamOf('好的'));
    const { service, prisma } = mkService(create);

    await service.sendMessageStream(
      'sess-1',
      '帮我看看这个方案',
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'dev-1',
    );

    expect(prisma.device.update).not.toHaveBeenCalled();
  });
});
