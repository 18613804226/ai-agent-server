import { describe, expect, it, vi } from 'vitest';
import { ChatController } from './chat.controller';

/**
 * 只传文件 / 只传已上传附件 / 只传图片，甚至不输问题时：
 * 控制器应补一条默认指令喂给大模型，而不是报「query 和文件/图片至少要提供一样」。
 */
function mkController() {
  const chatService = {
    sendMessageStream: vi
      .fn()
      .mockResolvedValue({ fullReply: 'ok', tokens: 1 }),
  };
  const attachmentService = {
    validateChatAttachment: vi.fn(),
    parseChatAttachment: vi.fn().mockResolvedValue({
      id: 'att-1',
      fileRef: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.pdf',
      url: '/chat/attachments/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.pdf',
      name: '测试.pdf',
      kind: 'document' as const,
      text: 'test',
      charCount: 4,
    }),
    rememberChatAttachment: vi.fn(),
  };
  const sessionService = {
    createSession: vi.fn(),
    getSessions: vi.fn(),
    getSessionDetail: vi.fn(),
    updateSessionTitle: vi.fn(),
    deleteSession: vi.fn(),
    clearMessages: vi.fn(),
  };
  const imageService = {
    uploadImage: vi.fn(),
    deleteUploadedImage: vi.fn(),
  };
  const knowledgeService = {
    uploadKnowledgeFile: vi.fn(),
    listKnowledgeFiles: vi.fn(),
    getKnowledgeFileProgress: vi.fn(),
    setKnowledgeFileEnabled: vi.fn(),
    deleteKnowledgeFile: vi.fn(),
  };
  const speechService = {
    textToSpeech: vi.fn(),
    speechToText: vi.fn(),
  };
  const excelService = { checkExcelFile: vi.fn() };
  const authService = { assertQuota: vi.fn(), recordUsage: vi.fn() };
  const controller = new ChatController(
    chatService as never,
    sessionService as never,
    imageService as never,
    attachmentService as never,
    knowledgeService as never,
    speechService as never,
    excelService as never,
    authService as never,
  );
  return {
    controller,
    chatService,
    sessionService,
    imageService,
    attachmentService,
    knowledgeService,
    speechService,
    excelService,
    authService,
  };
}

const mkRes = () =>
  ({ on: vi.fn(), writableFinished: true }) as never;

const mkFile = (): Express.Multer.File =>
  ({
    originalname: '测试.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7'),
    size: 8,
  }) as never;

async function drain(obs: any) {
  const events: any[] = [];
  await new Promise<void>((resolve) => {
    obs.subscribe({
      next: (event: any) => events.push(event.data),
      complete: () => resolve(),
      error: () => resolve(),
    });
  });
  return events;
}

describe('ChatController.streamMessage：只有文件没有 query', () => {
  it('只传 file、query 为空 → 用默认指令喂给模型，不报错', async () => {
    const { controller, chatService } = mkController();
    const obs = await controller.streamMessage(
      { id: 'dev-1' },
      'sess-1',
      { query: '' },
      mkFile(),
      mkRes(),
    );
    await drain(obs);

    expect(chatService.sendMessageStream).toHaveBeenCalledTimes(1);
    const [sessionId, query, , , , , , inline, persistContent] =
      chatService.sendMessageStream.mock.calls[0];
    expect(sessionId).toBe('sess-1');
    expect(query).toBe('请概括上面的内容。');
    expect(persistContent).toBe(''); // 落库用用户原文，不写系统补的默认指令
    expect(inline).toHaveLength(1);
    expect(inline[0].text).toBe('test');
  });

  it('只传 attachmentIds、query 为空 → 同样放行并用默认指令', async () => {
    const { controller, chatService } = mkController();
    const obs = await controller.streamMessage(
      { id: 'dev-1' },
      'sess-1',
      { query: '', attachmentIds: ['att-1'] },
      undefined,
      mkRes(),
    );
    await drain(obs);

    const [, query, , , , , attachmentIds] =
      chatService.sendMessageStream.mock.calls[0];
    expect(query).toBe('请概括上面的内容。');
    expect(attachmentIds).toEqual(['att-1']);
  });

  it('query 和文件都没有 → 400', async () => {
    const { controller } = mkController();
    await expect(
      controller.streamMessage({ id: 'dev-1' }, 'sess-1', { query: '' }, undefined, mkRes()),
    ).rejects.toThrow('query 和文件/图片至少要提供一样');
  });

  it('只传 images、query 为空 → 用默认指令喂给模型，不报错', async () => {
    const { controller, chatService } = mkController();
    const obs = await controller.streamMessage(
      { id: 'dev-1' },
      'sess-1',
      { query: '', images: ['/uploads/img-1234567890-abcdef01-2345-6789-abcd-ef0123456789.png'] },
      undefined,
      mkRes(),
    );
    await drain(obs);

    expect(chatService.sendMessageStream).toHaveBeenCalledTimes(1);
    const [, query, , images, , , , inline, persistContent] =
      chatService.sendMessageStream.mock.calls[0];
    expect(query).toBe('请概括上面的内容。');
    expect(images).toEqual([
      '/uploads/img-1234567890-abcdef01-2345-6789-abcd-ef0123456789.png',
    ]);
    expect(persistContent).toBe(''); // 落库用用户原文，不写系统补的默认指令
    expect(inline).toBeUndefined(); // 图片走 URL 列表，不是 inline file
  });

  it('只输 query、不带文件 → query 原样传入', async () => {
    const { controller, chatService } = mkController();
    const obs = await controller.streamMessage(
      { id: 'dev-1' },
      'sess-1',
      { query: '你好' },
      undefined,
      mkRes(),
    );
    await drain(obs);
    expect(chatService.sendMessageStream.mock.calls[0][1]).toBe('你好');
  });

  it('APP 端透传 platform，请求体显式声明优先于 Device.platform', async () => {
    const { controller, chatService } = mkController();
    const obs = await controller.streamMessage(
      { id: 'dev-1', platform: 'web' },
      'sess-1',
      { query: '你好', platform: 'ios' },
      undefined,
      mkRes(),
    );
    await drain(obs);
    expect(chatService.sendMessageStream.mock.calls[0][9]).toBe('ios');
  });

  it('未显式声明时回退到登录时上报的 Device.platform', async () => {
    const { controller, chatService } = mkController();
    const obs = await controller.streamMessage(
      { id: 'dev-1', platform: 'android' },
      'sess-1',
      { query: '你好' },
      undefined,
      mkRes(),
    );
    await drain(obs);
    expect(chatService.sendMessageStream.mock.calls[0][9]).toBe('android');
  });

  it('结构化工具事件与 done 指标原样透传', async () => {
    const { controller, chatService } = mkController();
    chatService.sendMessageStream.mockImplementation(
      async (_s: string, _q: string, onChunk: any) => {
        onChunk('thought', '🔧 调用 fetchWeatherInfo');
        onChunk('tool_call', {
          name: 'fetchWeatherInfo',
          args: '{"city":"北京"}',
          index: 0,
        });
        onChunk('tool_result', {
          name: 'fetchWeatherInfo',
          index: 0,
          result: '晴 26℃',
          resultLength: 5,
          durationMs: 123,
          status: 'success',
        });
        return {
          fullReply: 'ok',
          tokens: 10,
          model: 'glm-4.5-flash',
          completionTokens: 8,
          finishReason: 'stop',
          truncated: false,
          ttftMs: 300,
          durationMs: 900,
          sourcesCount: 2,
          historyKept: 3,
          historyDropped: 2,
          digestUsed: true,
        };
      },
    );
    const obs = await controller.streamMessage(
      { id: 'dev-1' },
      'sess-1',
      { query: '北京天气' },
      undefined,
      mkRes(),
    );
    const events = await drain(obs);
    expect(events).toContainEqual({
      type: 'thought',
      content: '🔧 调用 fetchWeatherInfo',
    });
    expect(events).toContainEqual({
      type: 'tool_call',
      name: 'fetchWeatherInfo',
      args: '{"city":"北京"}',
      index: 0,
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      name: 'fetchWeatherInfo',
      index: 0,
      result: '晴 26℃',
      resultLength: 5,
      durationMs: 123,
      status: 'success',
    });
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      model: 'glm-4.5-flash',
      completionTokens: 8,
      finishReason: 'stop',
      truncated: false,
      ttftMs: 300,
      durationMs: 900,
      sourcesCount: 2,
      historyKept: 3,
      historyDropped: 2,
      digestUsed: true,
    });
  });

  it('服务抛错时补一帧收敛文案并正常结束流', async () => {
    const { controller, chatService } = mkController();
    chatService.sendMessageStream.mockRejectedValue(
      new Error('Request failed with status code 401 invalid api key'),
    );
    const obs = await controller.streamMessage(
      { id: 'dev-1' },
      'sess-1',
      { query: '你好' },
      undefined,
      mkRes(),
    );
    const events = await drain(obs);
    expect(events).toContainEqual({
      type: 'error',
      content: '模型服务鉴权异常，请检查后端配置。',
    });
    expect(events[events.length - 1].type).toBe('error');
  });
});

describe('ChatController：演示辅助接口', () => {
  it('GET demo/questions 返回固定问题清单', async () => {
    const { controller } = mkController();
    const result = await controller.getDemoQuestions();
    expect(result.questions).toHaveLength(5);
    expect(result.questions[0]).toHaveProperty('question');
    expect(result.questions[0]).toHaveProperty('label');
  });

  it('清空消息走 clearMessages，并带上设备 ID 做归属校验', async () => {
    const { controller, sessionService } = mkController();
    sessionService.clearMessages = vi
      .fn()
      .mockResolvedValue({ id: 'sess-1', deleted: 3 });
    const result = await controller.clearSessionMessages(
      { id: 'dev-1' },
      'sess-1',
    );
    expect(sessionService.clearMessages).toHaveBeenCalledWith(
      'sess-1',
      'dev-1',
    );
    expect(result).toEqual({ id: 'sess-1', deleted: 3 });
  });
});

describe('ChatController.getAttachmentHtml：docx 在线预览', () => {
  it('返回 text/html + CSP 头，正文来自 service', async () => {
    const attachmentService = {
      getAttachmentHtml: vi
        .fn()
        .mockResolvedValue('<!DOCTYPE html><body><p>hi</p></body>'),
    };
    const controller = new ChatController(
      {} as never,
      {} as never,
      {} as never,
      attachmentService as never,
      {} as never,
      {} as never,
      {} as never,
      { assertQuota: vi.fn(), recordUsage: vi.fn() } as never,
    );
    const headers: Record<string, string> = {};
    const res = {
      setHeader: vi.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      send: vi.fn(),
    };
    const ref = '00000000-0000-4000-8000-000000000003.docx';
    await controller.getAttachmentHtml(ref, res as never);

    expect(attachmentService.getAttachmentHtml).toHaveBeenCalledWith(ref);
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(headers['Content-Security-Policy']).toContain(
      "default-src 'none'",
    );
    expect(headers['Content-Security-Policy']).toContain('img-src data:');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Cache-Control']).toBe('no-store');
    expect(res.send).toHaveBeenCalledWith(
      '<!DOCTYPE html><body><p>hi</p></body>',
    );
  });
});