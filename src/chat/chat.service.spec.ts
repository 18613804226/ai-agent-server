import { ChatService } from './chat.service';

describe('ChatService session source metadata', () => {
  beforeAll(() => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  });

  it('returns the current enabled state for saved sources and marks deleted files', async () => {
    const prisma = {
      chatSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'session-1',
          messages: [
            {
              id: 'message-1',
              sources: [
                { fileId: 'disabled-file', fileName: '已停用文档.pdf' },
                { fileId: 'deleted-file', fileName: '已删除文档.pdf' },
              ],
            },
          ],
        }),
      },
      knowledgeFile: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'disabled-file', enabled: false, status: 'indexed' },
        ]),
      },
    };
    const service = new ChatService(prisma as never, {} as never);

    const result = await service.getSessionDetail('session-1');

    expect(result?.messages[0].sources).toEqual([
      {
        fileId: 'disabled-file',
        fileName: '已停用文档.pdf',
        currentlyEnabled: false,
        currentStatus: 'indexed',
      },
      {
        fileId: 'deleted-file',
        fileName: '已删除文档.pdf',
        currentlyEnabled: false,
        currentStatus: 'deleted',
      },
    ]);
    expect(prisma.knowledgeFile.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['disabled-file', 'deleted-file'] } },
      select: { id: true, enabled: true, status: true },
    });
  });

  it('returns null without querying source files when the session does not exist', async () => {
    const prisma = {
      chatSession: { findUnique: vi.fn().mockResolvedValue(null) },
      knowledgeFile: { findMany: vi.fn() },
    };
    const service = new ChatService(prisma as never, {} as never);

    await expect(service.getSessionDetail('missing')).resolves.toBeNull();
    expect(prisma.knowledgeFile.findMany).not.toHaveBeenCalled();
  });
});

describe('ChatService createSession 超额清理', () => {
  it('已超上限时一次删够差额（23 → 删 4 → 建 1 = 20）', async () => {
    const existing = Array.from({ length: 23 }, (_, i) => ({
      id: `s-${i}`,
      createdAt: new Date(2026, 0, i + 1),
    }));
    const prisma = {
      chatSession: {
        findMany: vi.fn().mockResolvedValue(existing),
        deleteMany: vi.fn().mockResolvedValue({ count: 4 }),
        create: vi.fn().mockResolvedValue({ id: 's-new' }),
      },
    };
    const service = new ChatService(prisma as never, {} as never);

    await service.createSession('device-1');

    expect(prisma.chatSession.findMany).toHaveBeenCalledWith({
      where: { deviceId: 'device-1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(prisma.chatSession.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['s-0', 's-1', 's-2', 's-3'] } },
    });
    expect(prisma.chatSession.create).toHaveBeenCalledWith({
      data: { title: '', deviceId: 'device-1' },
    });
  });

  it('未到上限时不删任何会话', async () => {
    const prisma = {
      chatSession: {
        findMany: vi.fn().mockResolvedValue([{ id: 's-1' }]),
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 's-new' }),
      },
    };
    const service = new ChatService(prisma as never, {} as never);

    await service.createSession('device-1');

    expect(prisma.chatSession.deleteMany).not.toHaveBeenCalled();
  });
});

describe('ChatService deleteChatAttachment', () => {
  const mkService = (prisma: any) => new ChatService(prisma as never, {} as never);

  it('拒绝非法文件名（400）', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const service = mkService(prisma);
    await expect(service.deleteChatAttachment('not-a-valid-ref.txt')).rejects.toThrow(
      '非法文件名',
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('已被消息引用时返回 409', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ n: 1 }]) };
    const service = mkService(prisma);
    await expect(
      service.deleteChatAttachment('62cd2715-8d34-4c2b-9d7a-1f5a9c8b0000.pdf'),
    ).rejects.toThrow('该附件已被消息引用，不能删除');
  });
});
