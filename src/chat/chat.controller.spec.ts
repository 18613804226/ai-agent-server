import { describe, expect, it, vi } from 'vitest';
import { ChatController } from './chat.controller';

/**
 * 只传文件 / 只传已上传附件 / 只传图片，甚至不输问题时：
 * 控制器应补一条默认指令喂给大模型，而不是报「query 和文件/图片至少要提供一样」。
 */
function mkController() {
  const chatService = {
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
    sendMessageStream: vi
      .fn()
      .mockResolvedValue({ fullReply: 'ok', tokens: 1 }),
  };
  const authService = { assertQuota: vi.fn(), recordUsage: vi.fn() };
  const controller = new ChatController(
    chatService as never,
    authService as never,
  );
  return { controller, chatService, authService };
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
  await new Promise<void>((resolve) => {
    obs.subscribe({ complete: () => resolve(), error: () => resolve() });
  });
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
});

describe('ChatController.getAttachmentHtml：docx 在线预览', () => {
  it('返回 text/html + CSP 头，正文来自 service', async () => {
    const chatService = {
      getAttachmentHtml: vi
        .fn()
        .mockResolvedValue('<!DOCTYPE html><body><p>hi</p></body>'),
    };
    const controller = new ChatController(
      chatService as never,
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

    expect(chatService.getAttachmentHtml).toHaveBeenCalledWith(ref);
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