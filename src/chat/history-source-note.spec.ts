/**
 * 历史来源标注不能拼进历史消息正文 —— 模型会模仿该格式并原样输出，污染聊天记录。
 * 来源状态改为在 system prompt 的【历史对话来源状态】里统一说明。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatService } from './chat.service';

beforeAll(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  process.env.GLM_API_KEY = process.env.GLM_API_KEY || 'test-key';
});

function streamOf(text: string) {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
  })();
}

function mkService(history: any[], knowledgeFiles: any[] = []) {
  const prisma = {
    message: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue(history),
    },
    chatSession: {
      findUnique: vi.fn().mockResolvedValue({ id: 'sess-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    knowledgeFile: { findMany: vi.fn().mockResolvedValue(knowledgeFiles) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const vectorService = { searchSimilar: vi.fn().mockResolvedValue([]) };
  const service = new ChatService(prisma as never, vectorService as never);

  let captured: any = null;
  (service as any).zhipu = {
    chat: {
      completions: {
        create: vi.fn(async (payload: any) => {
          captured = payload;
          return streamOf('好的');
        }),
      },
    },
  };
  (service as any).openai = {
    chat: { completions: { create: vi.fn(async () => streamOf('备用')) } },
  };
  return { service, getCaptured: () => captured };
}

const send = (service: ChatService) =>
  service.sendMessageStream('sess-1', '你好', () => {}, undefined);

describe('历史来源状态：不再污染消息正文', () => {
  it('历史 assistant 正文不含「历史回答来源」标注', async () => {
    const { service, getCaptured } = mkService([
      { role: 'assistant', content: '旧回答A', sources: [] },
      { role: 'user', content: '旧问题' },
    ]);

    await send(service);

    const messages = getCaptured().messages as any[];
    for (const m of messages) {
      if (m.role === 'system') continue;
      const text = typeof m.content === 'string' ? m.content : '';
      expect(text).not.toContain('【历史回答来源');
    }
    const assistantMsg = messages.find(
      (m) => m.role === 'assistant' && m.content === '旧回答A',
    );
    expect(assistantMsg).toBeTruthy();
  });

  it('system prompt 含统一说明的【历史对话来源状态】', async () => {
    const { service, getCaptured } = mkService([
      { role: 'assistant', content: '旧回答A', sources: [] },
      { role: 'user', content: '旧问题' },
    ]);

    await send(service);

    const system = (getCaptured().messages as any[])[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('【历史对话来源状态】');
    expect(system.content).toContain('此前对话未引用知识库资料');
  });

  it('旧回答引用过的来源会在系统提示里标注停用状态', async () => {
    const { service, getCaptured } = mkService(
      [
        {
          role: 'assistant',
          content: '旧回答B',
          sources: [{ fileId: 'f1', fileName: '产品手册.pdf' }],
        },
        { role: 'user', content: '旧问题' },
      ],
      [{ id: 'f1', enabled: false }],
    );

    await send(service);

    const system = (getCaptured().messages as any[])[0];
    expect(system.content).toContain('产品手册.pdf（当前已停用）');
  });
});