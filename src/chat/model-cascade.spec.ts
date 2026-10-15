import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyComplexity,
  DEFAULT_MODELS,
  errorMessage,
  errorStatus,
  isDegradableError,
  isRateLimitError,
  loadModelCascadeConfig,
  providerForModel,
  resolveModelCandidates,
  resolveZhipuCredentials,
  zhipuThinkingParam,
  type ModelCascadeConfig,
} from './model-cascade';

const CONFIG: ModelCascadeConfig = {
  visionPrimary: 'GLM-4.6V-Flash',
  textSimple: 'GLM-4.7-Flash',
  textComplex: 'GLM-4.7-Flash',
  textExpert: 'qwen3.8-max',
  fallback: 'qwen3.7-flash',
  textComplexFallback: 'qwen3.7-flash',
  threshold: 3,
  expertThreshold: 5,
};

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

// 断言「代码默认值」前必须清掉本地 .env 的覆盖，否则测试结果取决于开发机配置
function clearModelEnv() {
  for (const k of Object.keys(process.env)) {
    if (/^CHAT_(MODEL|COMPLEXITY|EXPERT|GLM)/.test(k)) delete process.env[k];
  }
}

describe('模型分层：复杂度判定', () => {
  it('纯文本短问且无特征 → simple', () => {
    const r = classifyComplexity({ userQuery: '你好', hasImages: false });
    expect(r.tier).toBe('text');
    expect(r.complexity).toBe('simple');
    expect(r.score).toBe(0);
  });

  it('含图片 → vision 档，且直接获得 +1 分', () => {
    const r = classifyComplexity({ userQuery: '这张图是什么', hasImages: true });
    expect(r.tier).toBe('vision');
    expect(r.score).toBeGreaterThanOrEqual(1);
    expect(r.reasons.join()).toContain('含图片输入');
  });

  it('代码 + 复杂意图 → 超过 complex 阈值', () => {
    const r = classifyComplexity({
      userQuery: '帮我写一个 function 解析 JSON，要求详细步骤',
      hasImages: false,
      expertThreshold: 99, // 隔离 expert 档，只看 complex 判定
    });
    expect(r.score).toBeGreaterThanOrEqual(3);
    expect(r.complexity).toBe('complex');
  });

  it('长度是重要权重：>200 字直接 +2', () => {
    const r = classifyComplexity({ userQuery: '啊'.repeat(201), hasImages: false });
    expect(r.score).toBeGreaterThanOrEqual(2);
  });

  it('多问题计数生效', () => {
    const r = classifyComplexity({ userQuery: '你好？在吗？', hasImages: false });
    expect(r.reasons.join()).toContain('多问题x2');
  });

  it('实时信息查询被计入', () => {
    const r = classifyComplexity({ userQuery: '广州天气', hasImages: false, liveInfo: true });
    expect(r.reasons.join()).toContain('实时信息查询');
  });

  it('阈值可自定义', () => {
    const q = '帮我分析一下这个方案，要求列表输出';
    expect(
      classifyComplexity({
        userQuery: q,
        hasImages: false,
        threshold: 99,
      }).complexity,
    ).toBe('simple');
    expect(
      classifyComplexity({
        userQuery: q,
        hasImages: false,
        threshold: 1,
        expertThreshold: 99, // 隔离 expert 档，只看 complex 判定
      }).complexity,
    ).toBe('complex');
  });

  it('三档分级：simple / complex / expert', () => {
    // 0 分 → simple
    expect(
      classifyComplexity({ userQuery: '你好', hasImages: false }).complexity,
    ).toBe('simple');
    // 代码(2) + 复杂意图(2) + 结构化输出(1) = 5 → 达到 complex(3) 与 expert(5)
    const q = '帮我设计一个 function 架构方案，要求详细步骤';
    const r = classifyComplexity({ userQuery: q, hasImages: false });
    expect(r.score).toBeGreaterThanOrEqual(5);
    expect(r.complexity).toBe('expert');
  });

  it('expert 阈值必须 >= complex 阈值，避免永远打不满', () => {
    // 传入比 threshold 小的 expertThreshold 时自动抬到 threshold
    const r = classifyComplexity({
      userQuery: '帮我设计一个 function 架构方案，要求详细',
      hasImages: false,
      threshold: 3,
      expertThreshold: 1,
    });
    expect(r.complexity).toBe('expert');
  });

  it('expert 阈值抬高后，同样的问题落到 complex 档', () => {
    const q = '帮我分析一下这个方案，要求列表输出';
    const r = classifyComplexity({
      userQuery: q,
      hasImages: false,
      threshold: 3,
      expertThreshold: 99,
    });
    expect(r.score).toBeLessThan(99);
    expect(r.complexity).toBe('complex');
  });

  it('含文档/视频附件 → 档位下限抬到 complex（免费层 glm-4-flash 会无视附件）', () => {
    // 极简提问 + 无任何复杂特征，纯靠附件把档位拉起来
    const r = classifyComplexity({
      userQuery: '请总结一下',
      hasImages: false,
      hasAttachment: true,
    });
    expect(r.complexity).toBe('complex');
    expect(r.reasons.join()).toContain('含文档/视频附件');
  });

  it('含附件不会误升到 expert 档', () => {
    const r = classifyComplexity({
      userQuery: '请总结一下',
      hasImages: false,
      hasAttachment: true,
      expertThreshold: 5,
    });
    expect(r.complexity).toBe('complex');
  });

  it('无附件的极简提问仍是 simple', () => {
    const r = classifyComplexity({
      userQuery: '请总结一下',
      hasImages: false,
      hasAttachment: false,
    });
    expect(r.complexity).toBe('simple');
  });
});

describe('模型分层：档位与平台匹配', () => {
  it('glm 系列归智谱，qwen 系列归阿里云', () => {
    expect(providerForModel('glm-4-flash')).toBe('zhipu');
    expect(providerForModel('GLM-4.6V-Flash')).toBe('zhipu');
    expect(providerForModel('qwen3.7-flash')).toBe('dashscope');
    expect(providerForModel('qwen3.8-max')).toBe('dashscope');
    expect(providerForModel(' text-embedding-v4 ')).toBe('dashscope');
  });

  it('复杂档默认是 qwen → 必须路由到阿里云（曾因硬编码发错平台报 400）', () => {
    const list = resolveModelCandidates(
      { tier: 'text', complexity: 'complex', score: 4, reasons: [] },
      loadModelCascadeConfig(),
      { zhipuAvailable: true },
    );
    expect(list).toEqual([{ provider: 'dashscope', model: 'qwen3.7-flash' }]);
    expect(list.every((c) => c.provider === 'dashscope')).toBe(true);
  });

  it('expert 档默认模型也在阿里云，且与复杂档是不同模型', () => {
    clearModelEnv();
    const cfg = loadModelCascadeConfig();
    // 档位必须真的分开了，否则三级路由没意义
    expect(cfg.textExpert).not.toBe(cfg.textComplex);
    const list = resolveModelCandidates(
      { tier: 'text', complexity: 'expert', score: 7, reasons: [] },
      cfg,
      { zhipuAvailable: false }, // 即使没配 GLM 也不影响
    );
    expect(list[0]).toEqual({
      provider: 'dashscope',
      model: DEFAULT_MODELS.textExpert,
    });
  });

  it('视觉档默认 qwen3.7-flash 同样归阿里云', () => {
    const list = resolveModelCandidates(
      { tier: 'vision', complexity: 'simple', score: 1, reasons: [] },
      loadModelCascadeConfig(),
      { zhipuAvailable: true },
    );
    expect(list).toEqual([{ provider: 'dashscope', model: 'qwen3.7-flash' }]);
  });

  it('把某档改回 glm 模型时自动路由到智谱', () => {
    process.env.CHAT_MODEL_TEXT_COMPLEX = 'glm-4.6';
    const list = resolveModelCandidates(
      { tier: 'text', complexity: 'complex', score: 4, reasons: [] },
      loadModelCascadeConfig(),
      { zhipuAvailable: true },
    );
    expect(list[0]).toEqual({ provider: 'zhipu', model: 'glm-4.6' });
  });
});

describe('模型分层：候选链', () => {
  it('vision 档 → 视觉模型优先、qwen 兜底', () => {
    const list = resolveModelCandidates(
      classifyComplexity({ userQuery: 'x', hasImages: true }),
      CONFIG,
      { zhipuAvailable: true },
    );
    expect(list).toEqual([
      { provider: 'zhipu', model: 'GLM-4.6V-Flash' },
      { provider: 'dashscope', model: 'qwen3.7-flash' },
    ]);
  });

  it('text simple → 免费模型优先', () => {
    const list = resolveModelCandidates(
      classifyComplexity({ userQuery: '你好', hasImages: false }),
      CONFIG,
      { zhipuAvailable: true },
    );
    expect(list[0]).toEqual({ provider: 'zhipu', model: 'GLM-4.7-Flash' });
    expect(list[1]).toEqual({ provider: 'dashscope', model: 'qwen3.7-flash' });
  });

  it('未配置 GLM key → 只剩 qwen，行为与旧版一致', () => {
    const list = resolveModelCandidates(
      classifyComplexity({ userQuery: '帮我写代码', hasImages: false }),
      CONFIG,
      { zhipuAvailable: false },
    );
    expect(list).toEqual([{ provider: 'dashscope', model: 'qwen3.7-flash' }]);
  });

  it('模型名唯一决定平台，因此同名必去重（不会出现跨平台同名这种无意义组合）', () => {
    // zhipu 未配置 → 只剩 dashscope 一条链；若主备同名，去重后只剩 1 个候选
    const sameOnDashscope: ModelCascadeConfig = {
      ...CONFIG,
      textComplex: 'qwen3.7-flash',
      textComplexFallback: 'qwen3.7-flash',
    };
    const list = resolveModelCandidates(
      { tier: 'text', complexity: 'complex', score: 5, reasons: [] },
      sameOnDashscope,
      { zhipuAvailable: false },
    );
    expect(list).toHaveLength(1);

    // 主备不同名 → 两个候选，但平台都由模型名推导
    const crossModel = resolveModelCandidates(
      { tier: 'text', complexity: 'simple', score: 0, reasons: [] },
      { ...CONFIG, textSimple: 'glm-4-flash' },
      { zhipuAvailable: true },
    );
    expect(crossModel).toEqual([
      { provider: 'zhipu', model: 'glm-4-flash' },
      { provider: 'dashscope', model: 'qwen3.7-flash' },
    ]);
  });

  it('复杂档可以用独立兜底模型', () => {
    const cfg: ModelCascadeConfig = {
      ...CONFIG,
      textComplexFallback: 'qwen3.7-plus',
    };
    const list = resolveModelCandidates(
      classifyComplexity({
        userQuery: '帮我设计一个 function 架构方案，要求详细',
        hasImages: false,
        threshold: 3,
        expertThreshold: 99, // 强制落 complex 档
      }),
      cfg,
      { zhipuAvailable: true },
    );
    expect(list[1]).toEqual({ provider: 'dashscope', model: 'qwen3.7-plus' });
  });

  it('expert 档：顶级模型优先，并带两级退路', () => {
    const cfg: ModelCascadeConfig = {
      ...CONFIG,
      textExpert: 'qwen3.8-max',
      textComplex: 'qwen3.7-flash',
    };
    const list = resolveModelCandidates(
      {
        tier: 'text',
        complexity: 'expert',
        score: 7,
        reasons: [],
      },
      cfg,
      { zhipuAvailable: true }, // 配了 GLM 也不影响 expert 档
    );
    expect(list).toEqual([
      { provider: 'dashscope', model: 'qwen3.8-max' },
      { provider: 'dashscope', model: 'qwen3.7-flash' }, // textComplexFallback
    ]);
  });

  it('expert 档主备同名时去重，只留一个', () => {
    const list = resolveModelCandidates(
      { tier: 'text', complexity: 'expert', score: 9, reasons: [] },
      CONFIG, // expert=qwen3.8-max, fallback=complex= qwen3.7-flash
      { zhipuAvailable: false },
    );
    expect(list[0]).toEqual({ provider: 'dashscope', model: 'qwen3.8-max' });
    expect(list.filter((c) => c.model === 'qwen3.7-flash')).toHaveLength(1);
  });
});

describe('模型分层：降级判定', () => {
  it('限流/5xx/模型不存在 都要降级', () => {
    expect(isDegradableError({ status: 429 })).toBe(true);
    expect(isDegradableError({ status: 500 })).toBe(true);
    expect(isDegradableError({ code: 'InvalidParameter' })).toBe(true);
    expect(isDegradableError(new Error('ECONNRESET'))).toBe(true);
  });

  it('客户端主动断开 不降级', () => {
    expect(isDegradableError({ name: 'AbortError' })).toBe(false);
    expect(isDegradableError({ name: 'APIUserAbortError' })).toBe(false);
    expect(isDegradableError(null)).toBe(false);
  });

  it('状态码兼容裸 status 与 response.status', () => {
    expect(errorStatus({ status: 429 })).toBe(429);
    expect(errorStatus({ response: { status: 503 } })).toBe(503);
    expect(errorStatus({})).toBeUndefined();
  });

  it('429 与限流错误码都识别为限流', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
    expect(isRateLimitError({ code: 'Throttling.RateQuota' })).toBe(true);
    expect(isRateLimitError({ code: '1113' })).toBe(true); // 智谱并发超限
    expect(isRateLimitError({ status: 500 })).toBe(false);
    expect(isRateLimitError({ code: 'InvalidParameter' })).toBe(false);
  });

  it('服务端错误文案按多种结构提取', () => {
    expect(errorMessage({ response: { data: { error: { message: '智谱文案' } } } })).toBe('智谱文案');
    expect(errorMessage({ response: { data: { message: '阿里文案' } } })).toBe('阿里文案');
    expect(errorMessage({ message: '原生文案' })).toBe('原生文案');
    expect(errorMessage({})).toBe('');
  });
});

describe('模型分层：配置与凭据', () => {
  it('默认值覆盖三大路由（不写死型号，改默认值不应让测试变红）', () => {
    clearModelEnv();
    const cfg = loadModelCascadeConfig();
    expect(cfg.visionPrimary).toBe(DEFAULT_MODELS.visionPrimary);
    expect(cfg.textSimple).toBe(DEFAULT_MODELS.textSimple);
    expect(cfg.textComplex).toBe(DEFAULT_MODELS.textComplex);
    expect(cfg.textExpert).toBe(DEFAULT_MODELS.textExpert);
    expect(cfg.fallback).toBe(DEFAULT_MODELS.fallback);
    expect(cfg.threshold).toBe(3);
    expect(cfg.expertThreshold).toBe(5); // 默认比复杂档高 2 分
    // 三档互不相同，否则分级没有意义
    expect(new Set([cfg.textSimple, cfg.textComplex, cfg.textExpert]).size).toBe(3);
  });

  it('环境变量可覆盖模型名', () => {
    process.env.CHAT_MODEL_TEXT_SIMPLE = 'glm-4-air';
    process.env.CHAT_MODEL_COMPLEX_FALLBACK = 'qwen3.7-plus';
    process.env.CHAT_COMPLEXITY_THRESHOLD = '4';
    process.env.CHAT_EXPERT_THRESHOLD = '7';
    const cfg = loadModelCascadeConfig();
    expect(cfg.textSimple).toBe('glm-4-air');
    expect(cfg.textComplexFallback).toBe('qwen3.7-plus');
    expect(cfg.threshold).toBe(4);
    expect(cfg.expertThreshold).toBe(7);
  });

  it('专家档可用环境变量覆盖', () => {
    process.env.CHAT_MODEL_TEXT_EXPERT = 'qwen3.9-ultra';
    expect(loadModelCascadeConfig().textExpert).toBe('qwen3.9-ultra');
  });

  it('expert 阈值小于 complex 阈值时自动抬平', () => {
    process.env.CHAT_COMPLEXITY_THRESHOLD = '4';
    process.env.CHAT_EXPERT_THRESHOLD = '1';
    const cfg = loadModelCascadeConfig();
    expect(cfg.expertThreshold).toBe(4);
  });

  it('没有 key → zhipu 凭据为 null（触发单模型退化）', () => {
    delete process.env.GLM_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    expect(resolveZhipuCredentials()).toBeNull();
  });

  it('有 key → 默认走智谱官方端点', () => {
    process.env.GLM_API_KEY = 'test-key';
    expect(resolveZhipuCredentials()).toEqual({
      apiKey: 'test-key',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    });
  });

  it('思考链开关显式下发（模型默认是关的，省略参数不等于开启）', () => {
    delete process.env.CHAT_GLM_THINKING;
    expect(zhipuThinkingParam()).toEqual({ thinking: { type: 'disabled' } });
    process.env.CHAT_GLM_THINKING = 'false';
    expect(zhipuThinkingParam()).toEqual({ thinking: { type: 'disabled' } });
    process.env.CHAT_GLM_THINKING = 'true';
    expect(zhipuThinkingParam()).toEqual({ thinking: { type: 'enabled' } });
  });
});
