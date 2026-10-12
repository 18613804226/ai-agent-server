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
