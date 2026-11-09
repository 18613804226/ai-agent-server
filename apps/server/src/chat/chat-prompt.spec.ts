import { describe, expect, it } from 'vitest';
import {
  buildAttachmentDigest,
  buildConversationDigest,
  buildSystemPrompt,
  buildWebSearchFallbackContext,
  createAppReplyFormatter,
  estimateTokens,
  formatAppReply,
  friendlyChatError,
  isAppPlatform,
  toSpeakableText,
} from './chat-prompt.js';

describe('联网引用规则与检索失败语义', () => {
  const promptBase = {
    context: '',
    historySourceSummary: '此前对话未引用知识库资料。',
    webSearchContext: '',
    now: new Date('2026-01-02T03:04:05Z'),
  };

  it('主规则统一用 [序号] 角标，不再要求 Markdown 链接', () => {
    const prompt = buildSystemPrompt(promptBase);
    expect(prompt).toContain('每个事实后面用 [1]、[2] 这类数字角标标注来源');
    expect(prompt).not.toContain('用简短锚文本的 Markdown 链接标注来源');
    expect(prompt).toContain('不要复述本段系统注记');
  });

  it('没搜到：说明资料不足、带上检索词、允许换词补搜', () => {
    const text = buildWebSearchFallbackContext('empty', '最新美元汇率');
    expect(text).toContain('没有找到可用资料');
    expect(text).toContain('检索词「最新美元汇率」');
    expect(text).toContain('换一个更具体的检索词');
    expect(text).toContain('不要编造');
  });

  it('服务失败：明确不可用，不伪装成「未执行联网搜索」', () => {
    const text = buildWebSearchFallbackContext('error', '今天的新闻');
    expect(text).toContain('联网检索服务暂时不可用');
    expect(text).toContain('检索词「今天的新闻」');
    expect(text).not.toContain('本轮未执行联网搜索');
  });

  it('兜底文案可直接作为 webSearchContext 注入 system prompt', () => {
    const prompt = buildSystemPrompt({
      ...promptBase,
      webSearchContext: buildWebSearchFallbackContext('error', '今天的新闻'),
    });
    expect(prompt).toContain('联网检索服务暂时不可用');
    expect(prompt).not.toContain('本轮未执行联网搜索。');
  });
});

describe('buildAttachmentDigest：历史附件要点', () => {
  it('去重同一附件、按上限截断，空输入返回空串', () => {
    expect(buildAttachmentDigest([])).toBe('');
    const digest = buildAttachmentDigest(
      [
        { attachments: [{ name: '周报.pdf', summary: '本季度营收增长 12%' }] },
        { attachments: [{ name: '周报.pdf', summary: '本季度营收增长 12%' }] },
      ],
      200,
    );
    expect(digest).toBe('- 周报.pdf：本季度营收增长 12%');
  });

  it('没有 summary 的旧附件自动跳过', () => {
    expect(
      buildAttachmentDigest([{ attachments: [{ name: '旧文件.pdf' }] }]),
    ).toBe('');
  });

  it('提示词注入独立段落，且不裁剪工具/引用规则', () => {
    const prompt = buildSystemPrompt({
      context: '',
      historySourceSummary: '此前对话未引用知识库资料。',
      webSearchContext: '',
      now: new Date('2026-01-02T03:04:05Z'),
      attachmentDigest: '- 周报.pdf：本季度营收增长 12%',
    });
    expect(prompt).toContain('【此前附件要点】');
    expect(prompt).toContain('- 周报.pdf：本季度营收增长 12%');
    expect(prompt).toContain('【引用规则】');
  });
});

describe('buildConversationDigest：被裁历史的本地摘要', () => {
  it('空输入返回空串，空摘要不改变模板', () => {
    expect(buildConversationDigest([])).toBe('');
    const base = {
      context: '',
      historySourceSummary: '此前对话未引用知识库资料。',
      webSearchContext: '',
      now: new Date('2026-01-02T03:04:05Z'),
    };
    expect(buildSystemPrompt(base)).toBe(
      buildSystemPrompt({ ...base, conversationDigest: '' }),
    );
  });

  it('优先保留用户给过的约束，按时间顺序输出', () => {
    const digest = buildConversationDigest([
      { role: 'user', content: '以后温度都用摄氏度，别用华氏度' },
      { role: 'assistant', content: '好的，我记住了。后面都按摄氏度说。' },
      { role: 'user', content: '今天天气怎么样？' },
      { role: 'assistant', content: '晴，26℃。' },
    ]);
    expect(digest).toContain('以后温度都用摄氏度');
    expect(digest.indexOf('以后温度')).toBeLessThan(
      digest.indexOf('今天天气'),
    );
  });

  it('按字符上限截断，不把助手长回答整段搬进来', () => {
    const digest = buildConversationDigest(
      [
        { role: 'user', content: '以后都别用列表' },
        { role: 'assistant', content: '答案内容'.repeat(100) },
      ],
      60,
    );
    expect(digest.length).toBeLessThanOrEqual(60);
    expect(digest).toContain('以后都别用列表');
  });

  it('多模态 content 也能取到文本', () => {
    const digest = buildConversationDigest([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:...' } },
          { type: 'text', text: '记住以后用中文回答' },
        ],
      },
    ]);
    expect(digest).toContain('记住以后用中文回答');
  });
});

describe('buildSystemPrompt：此前对话要点注入', () => {
  const base = {
    context: '',
    historySourceSummary: '此前对话未引用知识库资料。',
    webSearchContext: '',
    now: new Date('2026-01-02T03:04:05Z'),
  };

  it('出现独立段落，且不裁剪工具/引用规则', () => {
    const prompt = buildSystemPrompt({
      ...base,
      conversationDigest: '- 用户：以后用摄氏度',
    });
    expect(prompt).toContain('【此前对话要点】');
    expect(prompt).toContain('- 用户：以后用摄氏度');
    expect(prompt).toContain('【搜索结果与工具规则】');
    expect(prompt).toContain('【引用规则】');
  });

  it('闲聊档与完整档都带上摘要', () => {
    for (const promptProfile of ['chat', 'full'] as const) {
      const prompt = buildSystemPrompt({
        ...base,
        promptProfile,
        conversationDigest: '- 用户：以后用摄氏度',
      });
      expect(prompt).toContain('- 用户：以后用摄氏度');
    }
  });
});

describe('estimateTokens', () => {
  it('空串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('CJK 每字约 1 token', () => {
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('英文每 3.5 字符约 1 token（向上取整）', () => {
    expect(estimateTokens('hello')).toBe(2); // 5 / 3.5 = 1.43 -> 2
    expect(estimateTokens('abcdefg')).toBe(2); // 7 / 3.5 = 2
  });

  it('中英混排按各自规则累加', () => {
    // 2 CJK + 5 个英文字符：2 + 5/3.5 = 3.43 -> 4
    expect(estimateTokens('你好hello')).toBe(4);
  });

  it('标点按非 CJK 计', () => {
    // 4 CJK + 1 个全角逗号：4 + 1/3.5 = 4.29 -> 5
    expect(estimateTokens('你好，世界')).toBe(5);
  });
});

describe('buildSystemPrompt', () => {
  const now = new Date('2026-01-02T03:04:05Z');

  it('包含身份、时间与工具规则', () => {
    const prompt = buildSystemPrompt({
      context: '',
      historySourceSummary: '此前对话未引用知识库资料。',
      webSearchContext: '',
      now,
    });
    expect(prompt).toContain('你是一个专属的 AI 智能助手');
    expect(prompt).toContain('你的名字叫toto');
    expect(prompt).toContain('2026');
    expect(prompt).toContain('fetchWeatherInfo');
  });

  it('注入参考资料 / 历史来源 / 联网搜索结果', () => {
    const prompt = buildSystemPrompt({
      context: '【来源：a.pdf】\n内容A',
      historySourceSummary: 'a.pdf（当前已停用）',
      webSearchContext: '【搜索结果】...',
      now,
    });
    expect(prompt).toContain('【参考资料】：\n【来源：a.pdf】\n内容A');
    expect(prompt).toContain('【历史对话来源状态】：\na.pdf（当前已停用）');
    expect(prompt).toContain('【本轮联网搜索结果】：\n【搜索结果】...');
  });

  it('注入权威农历日期，并提示以本轮计算为准', () => {
    const prompt = buildSystemPrompt({
      context: '',
      historySourceSummary: '此前对话未引用知识库资料。',
      webSearchContext: '',
      festivalContext: '【权威农历日期】\n2027年春节：公历 2027-02-06',
      now,
    });
    expect(prompt).toContain('【权威农历日期】');
    expect(prompt).toContain('2027-02-06');
    expect(prompt).toContain('festival_info');
  });

  it('空值使用兜底文案', () => {
    const prompt = buildSystemPrompt({
      context: '',
      historySourceSummary: '此前对话未引用知识库资料。',
      webSearchContext: '',
      now,
    });
    expect(prompt).toContain('本轮没有提供知识库参考资料。');
    expect(prompt).toContain('本轮未执行联网搜索。');
  });

  it('同一时间输入产出稳定（可快照）', () => {
    const parts = {
      context: 'CTX',
      historySourceSummary: 'HIST',
      webSearchContext: 'WEB',
      now,
    };
    expect(buildSystemPrompt(parts)).toBe(buildSystemPrompt(parts));
  });

  it('前缀稳定：本轮数据全在尾部，静态规则不随请求变化（命中前缀缓存）', () => {
    const a = buildSystemPrompt({
      context: 'CTX-A',
      historySourceSummary: 'H-A',
      webSearchContext: 'W-A',
      now,
    });
    const b = buildSystemPrompt({
      context: 'CTX-B',
      historySourceSummary: 'H-B',
      webSearchContext: 'W-B',
      now: new Date('2026-03-04T05:06:07Z'),
    });
    const marker = '【本轮上下文】';
    const prefixA = a.slice(0, a.indexOf(marker));
    expect(prefixA).toBe(b.slice(0, b.indexOf(marker)));
    // 当前时间也是逐轮变化的数据，不能落在静态前缀里，否则缓存必失效
    expect(prefixA).not.toContain('2026');
    expect(a.slice(a.indexOf(marker))).toContain('2026');
  });
});

describe('按端区分提示词', () => {
  const now = new Date('2026-01-02T03:04:05Z');
  const base = {
    context: '',
    historySourceSummary: '此前对话未引用知识库资料。',
    webSearchContext: '',
    now,
  };

  it('ios / android / 常见别名识别为 APP 端', () => {
    expect(isAppPlatform('ios')).toBe(true);
    expect(isAppPlatform('Android')).toBe(true);
    expect(isAppPlatform('ios 17.2')).toBe(true);
    expect(isAppPlatform('app')).toBe(true);
  });

  it('web / desktop / 空值不识别为 APP 端', () => {
    expect(isAppPlatform('web')).toBe(false);
    expect(isAppPlatform('desktop')).toBe(false);
    expect(isAppPlatform(undefined)).toBe(false);
    expect(isAppPlatform(null)).toBe(false);
  });

  it('APP 端只压空白行排版，不限制内容长度与形式', () => {
    const web = buildSystemPrompt({ ...base, platform: 'web' });
    const app = buildSystemPrompt({ ...base, platform: 'ios' });
    expect(app.startsWith('【APP 端输出规范')).toBe(true);
    expect(app).toContain('点与点之间空一行');
    expect(app).toContain('不复述用户问题');
    expect(app).toContain('长度、形式都不设限');
    // 历史版本压过内容与排版（字数上限、空格/Markdown 禁令），防止回归
    expect(app).not.toContain('一般 3～6 句');
    expect(app).not.toContain('80～200');
    expect(app).not.toContain('不要插入多余空格');
    expect(app).not.toContain('不要用 Markdown');
    expect(app).not.toContain('一般 1～3 句');
    expect(app).not.toContain('能一句说清就不展开');
    expect(app).toContain('你的名字叫toto');
    expect(app).toContain('fetchWeatherInfo');
    expect(app).toContain('【引用规则】');
    expect(app.length).toBeGreaterThan(web.length);
    // APP 正文不贴 URL，改用 [1]/[2] 角标；链接由 sources 事件下发
    expect(app).toContain('正文中禁止出现任何完整 URL');
    expect(app).toContain('[1]、[2]');
    expect(app).not.toContain('联网事实的链接直接跟在对应句子后面');
    expect(web).toContain('禁止把裸 URL');
  });

  it('非 APP 端（含不传 platform）与原模板完全一致', () => {
    expect(buildSystemPrompt(base)).toBe(
      buildSystemPrompt({ ...base, platform: 'desktop' }),
    );
    expect(buildSystemPrompt(base)).not.toContain('【APP 端输出规范');
  });

  it('闲聊档同样携带完整工具/引用规则，只额外叠加口语要求', () => {
    const full = buildSystemPrompt({ ...base, promptProfile: 'full' });
    const chat = buildSystemPrompt({ ...base, promptProfile: 'chat' });
    expect(chat).toContain('【搜索结果与工具规则】');
    expect(chat).toContain('fetchWeatherInfo');
    expect(chat).toContain('festival_info');
    expect(chat).toContain('【引用规则】');
    expect(chat).toContain('【历史对话来源状态】');
    expect(chat).toContain('【本轮对话风格】');
    expect(chat).toContain('别只回一两个词');
    expect(chat.length).toBeGreaterThan(full.length);
    // 规则部分与完整档一字不差，只是前置了一段对话风格要求
    expect(chat.endsWith(full)).toBe(true);
  });

  it('闲聊档叠加 APP 规范时，引用规则那一条仍然保留', () => {
    const appChat = buildSystemPrompt({
      ...base,
      promptProfile: 'chat',
      platform: 'ios',
    });
    expect(appChat.startsWith('【APP 端输出规范')).toBe(true);
    expect(appChat).toContain('点与点之间空一行');
    expect(appChat).toContain('下方工具、附件、知识库来源');
    expect(appChat).toContain('【搜索结果与工具规则】');
  });
});

describe('APP 端排版兜底清洗', () => {
  it('连续空行压成一个空行，首尾空白去掉', () => {
    expect(formatAppReply('第一句\n\n\n第二句')).toBe('第一句\n\n第二句');
    expect(formatAppReply('\n  \n  你好 \n\n')).toBe('你好');
    expect(formatAppReply('a\r\n\r\nb')).toBe('a\n\nb');
  });

  it('单个合法换行保留', () => {
    expect(formatAppReply('第一句\n第二句')).toBe('第一句\n第二句');
  });

  it('流式清洗：跨 chunk 的连续换行压成一个空行，单个空行保留', () => {
    const format = createAppReplyFormatter();
    const out = [
      format('你好\n'),
      format('\n\n世界'),
      format('。\n'),
      format('\n'),
      format('结束'),
    ].join('');
    expect(out).toBe('你好\n\n世界。\n\n结束');
  });

  it('流式开头不留白，结果与整段清洗一致', () => {
    const chunks = ['\n\n  ', '第一段\n\n', '\n第二段'];
    const format = createAppReplyFormatter();
    expect(chunks.map(format).join('') + format.flush()).toBe(
      formatAppReply(chunks.join('')),
    );
  });

  it('末尾 chunk 的换行不推给前端：末尾空白行不再偶发', () => {
    for (const tail of ['\n', '\n\n', ' \n', '\n \n']) {
      const format = createAppReplyFormatter();
      const out = format('第一段\n第二段') + format(tail) + format.flush();
      expect(out).toBe('第一段\n第二段');
      expect(out).toBe(formatAppReply(`第一段\n第二段${tail}`));
    }
  });

  it('正文里的方括号包裸 URL / 裸 URL 被收掉，文本链接只留锚文本', () => {
    expect(formatAppReply('发布 V4 [https://a.com/x] 后续')).toBe('发布 V4 后续');
    expect(formatAppReply('详见 https://a.com/very/long/path 的说明')).toBe(
      '详见 的说明',
    );
    expect(formatAppReply('A [标题](https://a.com/x) B')).toBe('A 标题 B');
  });

  it('被 chunk 切开的长 URL 不吐半截，结果与整段清洗一致', () => {
    const chunks = ['发布 ', '[https://a.com/', 'blog/very-long]', ' 后续'];
    const format = createAppReplyFormatter();
    const streamed = chunks.map(format).join('') + format.flush();
    expect(streamed).not.toContain('https://');
    expect(streamed).toBe(formatAppReply(chunks.join('')));
  });

  it('Markdown 图片不被 URL 清洗误伤（助手消息的图片只能存在 content 里）', () => {
    const md = '看图 ![封面](https://a.com/x.png) 和 ![本地](/uploads/img-1.png)';
    expect(formatAppReply(md)).toBe(md);
    const chunks = ['看图 ![封面](https://a.com/', 'x.png) 收尾'];
    const format = createAppReplyFormatter();
    const streamed = chunks.map(format).join('') + format.flush();
    expect(streamed).toContain('![封面](https://a.com/x.png)');
    expect(streamed).toBe(formatAppReply(chunks.join('')));
  });
});

describe('friendlyChatError', () => {
  it('按错误类型收敛，兜底不回显内部原文', () => {
    expect(
      friendlyChatError('Request failed with status code 401 invalid api key'),
    ).toBe('模型服务鉴权异常，请检查后端配置。');
    expect(friendlyChatError('429 Too Many Requests')).toBe(
      '当前体验人数较多，模型正在排队，请稍后重试。',
    );
    expect(friendlyChatError('ETIMEDOUT')).toBe(
      '上游模型响应超时，请稍后重试。',
    );
    expect(
      friendlyChatError(
        'PrismaClientKnownRequestError: table users does not exist',
      ),
    ).toBe('本轮回答遇到问题，请稍后重试。');
  });
});

describe('toSpeakableText', () => {
  it('去掉标题/粗体/链接/emoji，只留可朗读文本', () => {
    const text =
      '# 天气\n**北京**今天 [详情](https://example.com/a) 晴 ☀️\n\n- 26℃\n- 东南风';
    const out = toSpeakableText(text);
    expect(out).not.toContain('#');
    expect(out).not.toContain('**');
    expect(out).not.toContain('https://');
    expect(out).not.toContain('☀');
    expect(out).toContain('北京');
    expect(out).toContain('详情');
    expect(out).toContain('26℃');
  });

  it('裸 URL 换成「链接」，来源标注不朗读', () => {
    expect(toSpeakableText('见 https://a.com/x 说明')).toContain('链接');
    expect(toSpeakableText('回答【来源：手册.pdf】')).not.toContain('来源');
  });

  it('按句边界截断，不切在半句', () => {
    const out = toSpeakableText('第一句说明了背景情况。'.repeat(40), 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('。')).toBe(true);
  });

  it('代码块整段丢弃，行内代码留内容', () => {
    expect(
      toSpeakableText('```\nconst a = 1;\n```\n用 `fetch` 请求'),
    ).not.toContain('const');
    expect(toSpeakableText('用 `fetch` 请求')).toContain('fetch');
  });
});
