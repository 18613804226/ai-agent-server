// packages/agent-orchestrator/src/model-cascade.ts
/**
 * 模型分层与级联调度（Model Cascade）
 *
 * 设计决策：
 * 1. 成本分层：免费层（智谱 GLM 免费额度）前置承载大部分请求，
 *    付费层（DashScope qwen）只做兜底 —— FrugalGPT 思想。
 * 2. 多模态优先走视觉模型（便宜且专用），纯文本再按复杂度分流。
 * 3. 候选链降级：主模型请求失败（限流/5xx/模型不存在）时自动切换到
 *    下一个候选，仅重试「建连失败」，不重试已吐字的中途失败，
 *    避免给客户端重复推送内容。
 * 4. 未配置 GLM key 时自动退化为单一 qwen 模型，行为与旧版完全一致。
 */

export type ModelProvider = 'zhipu' | 'dashscope' | 'modelscope';

export interface ModelCandidate {
  provider: ModelProvider;
  model: string;
}

export interface Complexity {
  /** vision = 多模态输入；text = 纯文本 */
  tier: 'vision' | 'text';
  /** simple = 免费层可胜任；complex = 常规云端模型；expert = 顶级模型 */
  complexity: 'simple' | 'complex' | 'expert';
  /** 规则打分明细，便于线上排查「为什么走了贵模型」 */
  score: number;
  reasons: string[];
}

export interface ModelCascadeConfig {
  /**
   * 不参与复杂度评分、优先级最高的首选模型（有调用次数限制）。
   * 所有档位都插到链首；纯文本挂了先回 textSimple 再走评分链路，
   * vision 挂了直接回视觉模型。留空或 'off' 表示禁用，恢复纯评分路由。
   */
  priorityModel?: string;
  /** 含图片/视频时的首选（多模态） */
  visionPrimary: string;
  /** 纯文本-简单 首选 */
  textSimple: string;
  /** 纯文本-复杂 首选 */
  textComplex: string;
  /** 纯文本-最复杂 首选（顶级模型） */
  textExpert: string;
  /** 任一场景的首选都挂了之后的兜底 */
  fallback: string;
  /** 纯文本-复杂 的兜底（想升 plus 就配它） */
  textComplexFallback: string;
  /** 复杂度判定阈值，score >= threshold 才算 complex */
  threshold: number;
  /** 专家级阈值，score >= expertThreshold 算 expert（必须 >= threshold） */
  expertThreshold: number;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(env(name, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 默认模型名（单一事实来源：改这里即改默认档位）。
 * 测试也引用这个常量，避免默认值一调测试就红。
 */
export const DEFAULT_MODELS = {
  // ModelScope Model-Id（命名空间/名称），走 MODELSCOPE_API_KEY 的独立端点
  priorityModel: 'Qwen/Qwen3.8-Flash-Next',
  visionPrimary: 'qwen3.7-flash',
  textSimple: 'glm-4.5-flash',
  textComplex: 'qwen3.7-flash',
  textExpert: 'qwen3.8-max-0902',
  fallback: 'qwen3.7-flash',
} as const;

/**
 * 模型名默认走环境变量，换模型不用改代码。
 * 客户端（Electron）可传 overrides 覆盖，实现「在设置里配置模型」。
 */
export function loadModelCascadeConfig(
  overrides: Partial<ModelCascadeConfig> = {},
): ModelCascadeConfig {
  const threshold =
    overrides.threshold ?? envNumber('CHAT_COMPLEXITY_THRESHOLD', 3);
  const priorityRaw =
    overrides.priorityModel ??
    env('CHAT_MODEL_PRIORITY', DEFAULT_MODELS.priorityModel);
  // 次数用尽时可以设 off 临时摘掉首选，恢复纯评分路由
  const priorityModel = /^(off|none|disabled)$/i.test(priorityRaw.trim())
    ? ''
    : priorityRaw;
  return {
    priorityModel,
    // ⚠️ GLM-4.6V-Flash（免费视觉款）实测指令遵循弱：会把图片问题
    //    胡编成不存在的工具调用（如 fetchImageContent），回答质量不可用，
    //    因此视觉与复杂文本默认都走 qwen3.7-flash（全模态，付费但稳定）。
    //    免费文本层用 GLM-4.5-Flash：智谱免费额度里 4.7 之外最强的文本模型
    //    （4.7 免费额度被用得厉害、限流明显，所以退到 4.5）。
    visionPrimary:
      overrides.visionPrimary ??
      env('CHAT_MODEL_VISION', DEFAULT_MODELS.visionPrimary),
    textSimple:
      overrides.textSimple ??
      env('CHAT_MODEL_TEXT_SIMPLE', DEFAULT_MODELS.textSimple),
    textComplex:
      overrides.textComplex ??
      env('CHAT_MODEL_TEXT_COMPLEX', DEFAULT_MODELS.textComplex),
    // 最复杂的一档走顶级模型，成本最高但只留给真正难的任务
    textExpert:
      overrides.textExpert ??
      env('CHAT_MODEL_TEXT_EXPERT', DEFAULT_MODELS.textExpert),
    fallback:
      overrides.fallback ?? env('CHAT_MODEL_FALLBACK', DEFAULT_MODELS.fallback),
    // 复杂档兜底默认与全局兜底一致；需要更强能力时配 CHAT_MODEL_COMPLEX_FALLBACK=qwen3.7-plus
    textComplexFallback:
      overrides.textComplexFallback ??
      env('CHAT_MODEL_COMPLEX_FALLBACK', DEFAULT_MODELS.fallback),
    threshold,
    // 专家级阈值默认比复杂档高 2 分；配小了会把大量请求推向最贵的模型
    expertThreshold:
      overrides.expertThreshold ??
      Math.max(threshold, envNumber('CHAT_EXPERT_THRESHOLD', threshold + 2)),
  };
}

/**
 * 智谱客户端的思考链参数。
 *
 * 必须**显式**指定：实测 GLM-4.6V-Flash 默认是关闭思考的（省略参数 = 关闭），
 * 光删掉 disabled 参数并不会打开。默认关闭是因为思考链会把「你好」这种问候
 * 也产出上千字推理，严重拖慢首字。
 *
 * ⚠️ 注意：glm-4-flash 是非推理模型，无论怎么设都不会产出 reasoning_content；
 *    想要思考内容请用 GLM-4.6V-Flash / GLM-4.7-Flash 这类推理模型。
 */
export function zhipuThinkingParam(): Record<string, unknown> {
  return {
    thinking: {
      type: process.env.CHAT_GLM_THINKING === 'true' ? 'enabled' : 'disabled',
    },
  };
}

/** 问答档位：闲聊要活泼，基于资料/附件的回答要严谨，实时信息居中，倾诉要松弛 */
export type ChatSamplingProfile =
  | 'casual'
  | 'knowledge'
  | 'live'
  | 'emotional';

const CHAT_SAMPLING_PRESETS: Record<
  ChatSamplingProfile,
  { temperature: number; top_p: number; canLimitOutput?: boolean }
> = {
  casual: { temperature: 0.7, top_p: 0.8 },
  knowledge: { temperature: 0.4, top_p: 0.8 },
  live: { temperature: 0.5, top_p: 0.8 },
  emotional: { temperature: 0.85, top_p: 0.9, canLimitOutput: true },
};

/**
 * 按任务分档的采样参数：只由问答链路传入，代码 Agent 链路保持服务端默认。
 *
 * top_p 用于收敛候选词，避免温度升高后发散；emotional 档放宽到 0.9 让措辞更自然。
 * `CHAT_GLM_TEMPERATURE` / `CHAT_GLM_TOP_P` 可覆盖所有档位；越界或非法值
 * 回落到当前档位的预设，避免脏配置直接发给上游。
 *
 * 情绪档的 `max_tokens` 默认不下发：Demo 链路各分支都保留工具调用展示，
 * 限长可能截断 tool_calls 让前端看不到完整调用。需要演示短回复时再显式设置
 * `CHAT_EMOTIONAL_MAX_TOKENS=200`；其它档位永不下发，不打穿资料题的长回答。
 */
export function zhipuChatSamplingParam(
  profile: ChatSamplingProfile = 'casual',
): { temperature: number; top_p: number; max_tokens?: number } {
  const preset = CHAT_SAMPLING_PRESETS[profile] ?? CHAT_SAMPLING_PRESETS.casual;
  const sampling = (name: string, fallback: number): number => {
    const n = envNumber(name, fallback);
    return n > 0 && n <= 1 ? n : fallback;
  };
  const params: {
    temperature: number;
    top_p: number;
    max_tokens?: number;
  } = {
    temperature: sampling('CHAT_GLM_TEMPERATURE', preset.temperature),
    top_p: sampling('CHAT_GLM_TOP_P', preset.top_p),
  };
  if (preset.canLimitOutput) {
    const limit = envNumber('CHAT_EMOTIONAL_MAX_TOKENS', 0);
    if (Number.isInteger(limit) && limit > 0) params.max_tokens = limit;
  }
  return params;
}

/** 智谱客户端的 key / baseUrl：单独一套，缺 key 时返回 null（自动退化为单模型） */
export function resolveZhipuCredentials(): {
  apiKey: string;
  baseURL: string;
} | null {
  const apiKey = env('GLM_API_KEY', '') || env('ZHIPU_API_KEY', '');
  if (!apiKey) return null;
  return {
    apiKey,
    baseURL:
      env('GLM_BASE_URL', '') ||
      env('ZHIPU_BASE_URL', '') ||
      'https://open.bigmodel.cn/api/paas/v4',
  };
}

const CODE_MARKERS = [
  '```',
  'function',
  '=>',
  'const ',
  'let ',
  'var ',
  'import ',
  'class ',
  'def ',
  'public ',
  'SELECT ',
  'async ',
  'throw ',
  'console.log',
  // 常见语言 / 技术名词：代码实现类请求必须进 complex，否则会落到免费简单档
  'TypeScript',
  'JavaScript',
  'Python',
  'Java',
  'Go',
  'Rust',
  'C++',
  'C#',
  'PHP',
  'Ruby',
  'Swift',
  'Kotlin',
  'Scala',
  '代码',
  '程序',
  '脚本',
  '函数',
  '接口',
  'API',
  'HTTP',
  'SQL',
  '正则',
  '算法',
  '数据结构',
  '并发',
  '缓存',
  '模块',
  '框架',
  '编译',
  '部署',
  '客户端',
  '服务端',
  '数据库',
  '前端',
  '后端',
];
const COMPLEX_INTENT = [
  '分析',
  '解释',
  '对比',
  '设计',
  '实现',
  '架构',
  'debug',
  'Debug',
  'DEBUG',
  '排查',
  '优化',
  '重构',
  '写一个',
  '写个',
  '帮我写',
  '生成代码',
  '改代码',
  '翻译',
  '总结',
  '提炼',
  '评估',
  '方案',
  '策略',
];
const COMPUTATION = [
  '%',
  '＋',
  '×',
  '÷',
  '等于',
  '计算',
  '多少',
  '折扣',
  '利率',
  '汇率',
  '日期差',
  '单位换算',
  '统计',
];
const LONG_OUTPUT = [
  '详细',
  '完整',
  '步骤',
  '列表',
  '表格',
  '报告',
  '逐条',
  '逐项',
];

/**
 * 纯规则复杂度判定（零额外开销、可解释）。
 * 规则命中会记进 reasons，方便看日志判断阈值是否合理。
 */
export function classifyComplexity(input: {
  userQuery: string;
  hasImages: boolean;
  liveInfo?: boolean;
  threshold?: number;
  expertThreshold?: number;
}): Complexity {
  const q = input.userQuery || '';
  const reasons: string[] = [];
  let score = 0;
  const push = (points: number, reason: string) => {
    score += points;
    reasons.push(`${reason}(+${points})`);
  };

  if (input.hasImages) {
    push(1, '含图片输入走视觉模型');
  }
  if (q.length > 200) push(2, '长输入>200字');
  else if (q.length > 80) push(1, '中等长度输入>80字');

  const questionMarks = (q.match(/[?？]/g) || []).length;
  if (questionMarks > 1) push(1, `多问题x${questionMarks}`);

  const hit = (list: string[]) => list.filter((k) => q.includes(k));
  const codeHits = hit(CODE_MARKERS);
  if (codeHits.length) push(2, `代码特征:${codeHits.slice(0, 2).join('/')}`);
  const intentHits = hit(COMPLEX_INTENT);
  if (intentHits.length)
    push(2, `复杂意图:${intentHits.slice(0, 2).join('/')}`);
  const calcHits = hit(COMPUTATION);
  if (calcHits.length) push(1, `含计算/统计:${calcHits.slice(0, 2).join('/')}`);
  const outHits = hit(LONG_OUTPUT);
  if (outHits.length)
    push(1, `要求结构化输出:${outHits.slice(0, 2).join('/')}`);
  if (input.liveInfo) push(1, '实时信息查询');

  const threshold = input.threshold ?? 3;
  // 专家级阈值默认比复杂档高 2 分；外部传入 0 或负值时退回默认，避免永远打不满
  const expertThreshold = Math.max(
    threshold,
    input.expertThreshold ?? threshold + 2,
  );
  const level =
    score >= expertThreshold
      ? 'expert'
      : score >= threshold
        ? 'complex'
        : 'simple';
  return {
    tier: input.hasImages ? 'vision' : 'text',
    complexity: level,
    score,
    reasons,
  };
}

/**
 * 附件「拒答」识别：免费层（GLM Flash 系列）会把「用户上传的附件」当成它没权限访问的东西而拒答
 * （实测：用户问句里出现「我上传的附件/文件」就触发，与系统提示无关）。
 * 命中后由调用方换到下一个候选（qwen）重试，而不是把这句拒答丢给用户。
 */
export const ATTACHMENT_REFUSAL_RE =
  /无法[^。\n！!]{0,24}(访问|读取|阅读|查看|打开|获取)[^。\n！!]{0,24}(附件|文件|上传|文档)/;

export function isAttachmentRefusal(text: string): boolean {
  return ATTACHMENT_REFUSAL_RE.test(text || '');
}

/**
 * 按模型名推导它属于哪个平台：
 * 智谱的模型都以 glm 开头（视觉系列 cogview、charglm 也归智谱），
 * ModelScope 的 Model-Id 带命名空间斜杠（Qwen/Qwen3.8-Flash-Next），
 * 其余归阿里云 DashScope（qwen 系列、text-embedding、paraformer 等）。
 *
 * 之前按「档位」硬编码 provider，结果把默认值改成 qwen3.7-flash 后，
 * 模型被发到智谱端点，直接 400 模型不存在（靠降级才兜住）。
 * 改成按模型名推导后，用户改任何 CHAT_MODEL_* 都不会再发错平台。
 */
export function providerForModel(model: string): ModelProvider {
  const name = model.trim();
  if (/^(glm|chatglm|cogview|charglm)/i.test(name)) return 'zhipu';
  // ModelScope 需要独立端点 + 独立 Token，发到 DashScope 会 404
  if (name.includes('/')) return 'modelscope';
  return 'dashscope';
}

/**
 * 按复杂度生成有序候选链（去重、去未配置 provider）。
 * zhipu 未配置 key 时只剩 dashscope，等价于旧版单模型行为。
 */
export function resolveModelCandidates(
  complexity: Complexity,
  config: ModelCascadeConfig,
  opts: { zhipuAvailable: boolean },
): ModelCandidate[] {
  const list: ModelCandidate[] = [];
  const add = (model: string) => {
    if (!model) return;
    const provider = providerForModel(model);
    if (provider === 'zhipu' && !opts.zhipuAvailable) return;
    // 同一模型不重复排（避免主备是同一个模型时白试一次）
    if (list.some((c) => c.provider === provider && c.model === model)) return;
    list.push({ provider, model });
  };

  // 有次数限制的首选模型：不受评分影响，所有档位都插到链首。
  // 纯文本档挂了先回免费层 4.5-Flash，再按评分走原来的三级链路；
  // vision 档跳过纯文本 4.5-Flash，直接回视觉模型（首选本身支持图片）。
  if (config.priorityModel) {
    add(config.priorityModel);
    if (complexity.tier !== 'vision') add(config.textSimple);
  }

  if (complexity.tier === 'vision') {
    add(config.visionPrimary);
    add(config.fallback);
  } else if (complexity.complexity === 'expert') {
    // 最复杂：顶级模型优先，挂了退回复杂档模型（保证始终能答）
    add(config.textExpert);
    add(config.textComplexFallback);
    add(config.fallback);
  } else if (complexity.complexity === 'complex') {
    // 复杂档：主模型 → 免费兜底 → 付费全局兜底（免费额度耗尽后仍能答）
    add(config.textComplex);
    add(config.textComplexFallback);
    add(config.fallback);
  } else {
    add(config.textSimple);
    add(config.fallback);
  }
  return list;
}

/**
 * 判断错误是否为限流（免费层配额/并发/QPS 上限）。
 * 限流是**暂时**的：应该原地退避重试同一个模型，而不是立刻降级到付费模型。
 */
export function isRateLimitError(err: unknown): boolean {
  const e = err as {
    status?: number;
    response?: { status?: number };
    code?: string;
  };
  const status = e?.status ?? e?.response?.status;
  if (status === 429) return true;
  return e?.code === 'Throttling.RateQuota' || e?.code === '1113';
}

/** 取服务端的错误文案（智谱/阿里云字段不同，尽量都覆盖） */
export function errorMessage(err: unknown): string {
  const e = err as {
    message?: string;
    response?: { data?: { error?: { message?: string }; message?: string } };
  };
  const data = e?.response?.data;
  return (
    data?.error?.message ||
    data?.message ||
    (typeof e?.message === 'string' ? e.message : '')
  );
}

/**
 * 判断错误是否值得降级到下一个候选。
 *
 * 401/403 属于配置/权限问题，换模型也没用，直接失败，避免白试整条候选链；
 * 402（额度/欠费）也降级——免费额度用完后应该退到付费兜底模型，而不是直接失败；
 * 其余错误（限流、5xx、模型不存在、连不上、超时）都降级——
 * 实际踩过「模型名不存在 404」和「建连超时」靠降级自救的坑。
 */
export function isDegradableError(err: unknown): boolean {
  const e = err as {
    name?: string;
    message?: string;
    code?: string;
    status?: number;
    response?: { status?: number };
  };
  if (!e) return false;
  if (e.name === 'AbortError' || e.name === 'APIUserAbortError') return false;

  const status = e.status ?? e.response?.status;
  if (status === 401 || status === 403) return false;


  if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') return true;
  if (e.name === 'TimeoutError') return true;
  return true;
}

/** 从错误里取状态码（OpenAI SDK 与裸 fetch 的字段位置不同） */
export function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status;
}

/**
 * 生成「模型选择」思考文本，推给前端让用户看到为什么选了这个模型。
 * 各 agent 共用，避免每个宿主各写一份。
 */
export function formatRoutingThought(
  complexity: Complexity,
  candidates: ModelCandidate[],
  config: ModelCascadeConfig,
  /** 场景标签：编辑器传「Agent 任务」，替代默认的「常规任务」（仅简单档） */
  sceneLabel?: string,
): string {
  const defaultTierText =
    complexity.tier === 'vision'
      ? '多模态输入'
      : complexity.complexity === 'expert'
        ? '高难度任务'
        : complexity.complexity === 'complex'
          ? '复杂任务'
          : '常规任务';
  const tierText =
    sceneLabel &&
    complexity.tier !== 'vision' &&
    complexity.complexity === 'simple'
      ? sceneLabel
      : defaultTierText;
  const backups = candidates
    .slice(1)
    .map((c) => c.model)
    .filter(Boolean);
  // 首选模型不参与评分、直接插到链首。不显式说明的话，括号里的「复杂度评分 X/阈值」
  // 容易被误读成「按评分选了首选模型」，所以把这条决策也写进思考流。
  const isPriorityFirst =
    !!config.priorityModel && candidates[0].model === config.priorityModel;
  const priorityNote = isPriorityFirst
    ? '；本轮优先走不参与评分的首选模型（用尽/429 直接降级）'
    : '';
  return (
    `模型选择：${candidates[0].model}（${tierText}，复杂度评分 ` +
    `${complexity.score}/${config.threshold}）` +
    priorityNote +
    (backups.length ? `，备用 ${backups.join('、')}。` : '，无备用。') +
    (complexity.reasons.length
      ? `判定依据：${complexity.reasons.join('、')}`
      : '')
  );
}
