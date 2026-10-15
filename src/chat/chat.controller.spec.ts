import { describe, expect, it, vi } from 'vitest';
import { ChatController } from './chat.controller';

/**
 * 只传文件 / 只传已上传附件、不输问题时：
 * 控制器应补一条默认指令，把文件喂给大模型，而不是报「query 和文件至少要提供一样」。
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
    const [sessionId, query, , , , , , inline] =
      chatService.sendMessageStream.mock.calls[0];
    expect(sessionId).toBe('sess-1');
    expect(query).toBe('请阅读我上传的附件内容，并给出简明总结。');
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
    expect(query).toBe('请阅读我上传的附件内容，并给出简明总结。');
    expect(attachmentIds).toEqual(['att-1']);
  });

  it('query 和文件都没有 → 400', async () => {
    const { controller } = mkController();
    await expect(
      controller.streamMessage({ id: 'dev-1' }, 'sess-1', { query: '' }, undefined, mkRes()),
    ).rejects.toThrow('query 和文件至少要提供一样');
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