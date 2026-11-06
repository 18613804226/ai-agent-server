/**
 * 面试 Demo 离线回放：预录一组固定问答（含工具链事件），
 * 断网 / 免费层限流 / 余额不足时仍能完整走完演示流程。
 *
 * 纯数据与纯函数，不依赖 Nest / 数据库 / 网络，便于单测。
 * 注意：回放里不编造具体事实、URL 或来源文件，只演示「流程长什么样」。
 */

/** 与 chat.service.ts 的流式回调签名一致 */
export type DemoEvent = [
  type: 'thought' | 'content' | 'tool_call' | 'tool_result',
  payload: string | Record<string, unknown>,
];

export interface DemoReplayEntry {
  /** 演示面板可一键填入的固定问题 */
  question: string;
  /** 场景标签，供 Demo UI 分组 */
  label: string;
  /** 命中关键词（对用户问题做小写包含匹配） */
  keywords: string[];
  /** 正文之前的工具链 / 检索事件 */
  lead: DemoEvent[];
  /** 最终回答：既拆成 content 事件推流，也用于落库 */
  reply: string;
  /** 引用来源，回放时推 sources 事件 */
  sources: Array<Record<string, unknown>>;
}

/**
 * 回放开关：
 * - 'forced'：CHAT_DEMO_REPLAY=true/false 中的 true，完全不请求模型，纯离线演示
 * - 'off'：显式关闭，出错也不回放
 * - 'fallback'（默认）：只在主链路失败时兜底，正常情况完全不介入
 */
export type DemoReplayMode = 'forced' | 'fallback' | 'off';

export function demoReplayMode(): DemoReplayMode {
  const value = (process.env.CHAT_DEMO_REPLAY || '').trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'force') return 'forced';
  if (value === 'off' || value === 'false' || value === '0') return 'off';
  return 'fallback';
}

/**
 * 预录演示流程。顺序按「越具体越靠前」排，避免「你好，今天天气」被闲聊档抢走。
 */
export const DEMO_REPLAYS: DemoReplayEntry[] = [
  {
    question: '北京今天天气怎么样？',
    label: '工具调用（天气）',
    keywords: ['天气', '气温', '下雨', '温度', '带伞'],
    lead: [
      ['thought', '正在查询天气…'],
      [
        'tool_call',
        {
          name: 'fetchWeatherInfo',
          args: '{"city":"北京"}',
          index: 0,
        },
      ],
      [
        'tool_result',
        {
          name: 'fetchWeatherInfo',
          index: 0,
          result: '演示回放：天气工具返回成功',
          resultLength: 13,
          durationMs: 120,
          status: 'success',
        },
      ],
    ],
    reply:
      '演示回放模式：这里会展示一次完整的工具调用链——模型先决定调天气工具，拿到结果后再组织成自然语言的回答。',
    sources: [],
  },
  {
    question: '最近有什么 AI 新消息？',
    label: '联网检索 + 逐条引用',
    keywords: ['最新', '新闻', '热搜', '新消息', '股价', '汇率', '今天'],
    lead: [
      ['thought', '🔎 已联网检索：2 条结果。'],
      [
        'tool_call',
        { name: 'web_search', args: '{"query":"最近 AI 新消息"}', index: 0 },
      ],
      [
        'tool_result',
        {
          name: 'web_search',
          index: 0,
          result: '演示回放：检索到 2 条结果',
          resultLength: 14,
          durationMs: 240,
          status: 'success',
        },
      ],
    ],
    reply:
      '演示回放模式：回答实时信息时，每条事实后面会跟上对应结果的原始链接，不会编造来源；没有检索到结果就直接说明。',
    sources: [],
  },
  {
    question: '帮我总结一下知识库文档',
    label: '知识库 RAG + 来源标注',
    keywords: ['知识库', '文档', '资料', '总结', '这份文件', '附件'],
    lead: [['thought', '正在检索知识库…']],
    reply:
      '演示回放模式：回答只基于本轮实际检索到的、当前启用的文档，末尾用一行【来源：文件名】标注；旧回答引用过的停用文档不会被当成依据。',
    sources: [
      {
        fileId: 'demo-replay',
        fileName: '演示文档.pdf',
        usedInThisReply: true,
      },
    ],
  },
  {
    question: '刚才那点能再说清楚一点吗？',
    label: '多轮追问',
    keywords: ['刚才', '前面', '再说', '继续', '详细', '展开'],
    lead: [],
    reply:
      '演示回放模式：多轮追问会带上最近几轮历史，并结合本轮的来源状态来判断旧资料能不能继续用，不会把停用的文档翻出来当新依据。',
    sources: [],
  },
  {
    question: '你好，你是谁？',
    label: '闲聊 / 身份',
    keywords: ['你好', '你是谁', '在吗', '介绍', 'hi', 'hello'],
    lead: [],
    reply:
      '我是 toto，一个由开发者独立打造的 AI 助手。想随便聊聊、查点资料，或者看看工具调用和联网检索的完整流程，都可以。',
    sources: [],
  },
];

/** 没命中固定问题时的通用兜底：只说明状态，不编造任何事实 */
export const DEMO_FALLBACK: DemoReplayEntry = {
  question: '',
  label: '通用兜底',
  keywords: [],
  lead: [],
  reply:
    '当前模型服务暂时不可用，已切换到演示回放模式。可以用面板上的固定问题，我照样能把工具调用、联网检索、知识库引用这几条流程完整走一遍。',
  sources: [],
};

export function findDemoReplay(query: string): DemoReplayEntry | undefined {
  const q = (query || '').trim().toLowerCase();
  if (!q) return undefined;
  return DEMO_REPLAYS.find((entry) =>
    entry.keywords.some((keyword) => q.includes(keyword)),
  );
}

/** 演示面板用：固定问题清单 */
export function demoQuestions(): Array<{ question: string; label: string }> {
  return DEMO_REPLAYS.map(({ question, label }) => ({ question, label }));
}

/**
 * 展开成可回放的事件序列：先工具链，再把回答切成小段模拟流式打字。
 * 不塞真实 sleep，回放保持确定性、可单测；打字观感由 SSE 逐帧送达产生。
 */
export function demoReplayEvents(entry: DemoReplayEntry): DemoEvent[] {
  const content: DemoEvent[] = [];
  const chunkSize = 12;
  for (let i = 0; i < entry.reply.length; i += chunkSize) {
    content.push(['content', entry.reply.slice(i, i + chunkSize)]);
  }
  return [...entry.lead, ...content];
}
