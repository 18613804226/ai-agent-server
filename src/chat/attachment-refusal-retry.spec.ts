/**
 * 附件拒答兜底：glm-4-flash 对「上传的附件」拒答时，应静默切到 qwen 重试，
 * 用户只看到 qwen 的正常回答，看不到那句拒答。
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

function mkService(zhipuText: string, qwenText: string) {
  const prisma = {
    message: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    chatSession: {
      findUnique: vi.fn().mockResolvedValue({ id: 'sess-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    knowledgeFile: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const vectorService = { searchSimilar: vi.fn().mockResolvedValue([]) };
  const service = new ChatService(prisma as never, vectorService as never);

  const zhipuCreate = vi.fn(async () => streamOf(zhipuText));
  const qwenCreate = vi.fn(async () => streamOf(qwenText));
  (service as any).zhipu = {
    chat: { completions: { create: zhipuCreate } },
  };
  (service as any).openai = {
    chat: { completions: { create: qwenCreate } },
  };
  return { service, zhipuCreate, qwenCreate };
}

const inlineAttachment = [
  { name: '未命名1_加水印.pdf', kind: 'document' as const, text: 'test' },
];

describe('附件拒答兜底：glm 拒答 → qwen 重试', () => {
  it('glm 拒答时切 qwen，用户只看到 qwen 的正常回答', async () => {
    const { service, zhipuCreate, qwenCreate } = mkService(
      '很抱歉，但我无法直接访问或阅读您上传的附件内容。',
      '文档内容只包含一个单词 test。',
    );

    const contents: string[] = [];
    await service.sendMessageStream(
      'sess-1',
      '请概括上面的内容。',
      (type, text) => {
        if (type === 'content') contents.push(text as string);
      },
      undefined,
      undefined,
      undefined,
      undefined,
      inlineAttachment,
    );

    const joined = contents.join('');
    expect(joined).toContain('文档内容只包含一个单词 test');
    expect(joined).not.toContain('无法直接访问');
    expect(zhipuCreate).toHaveBeenCalledTimes(1);
    expect(qwenCreate).toHaveBeenCalledTimes(1);
  });

  it('glm 正常回答时不触发重试', async () => {
    const { service, zhipuCreate, qwenCreate } = mkService(
      '文档内容只包含一个单词 test。',
      '不应出现的备用回答',
    );

    const contents: string[] = [];
    await service.sendMessageStream(
      'sess-1',
      '概括一下',
      (type, text) => {
        if (type === 'content') contents.push(text as string);
      },
      undefined,
      undefined,
      undefined,
      undefined,
      inlineAttachment,
    );

    expect(contents.join('')).toContain('文档内容只包含一个单词 test');
    expect(zhipuCreate).toHaveBeenCalledTimes(1);
    expect(qwenCreate).not.toHaveBeenCalled();
  });

  it('无附件时不启用拒答守卫（正常单模型回答）', async () => {
    const { service, qwenCreate } = mkService(
      '很抱歉，但我无法直接访问或阅读您上传的附件内容。',
      '备用回答',
    );

    const contents: string[] = [];
    await service.sendMessageStream(
      'sess-1',
      '你好',
      (type, text) => {
        if (type === 'content') contents.push(text as string);
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    // 无附件：即使出现「无法访问附件」字样也不重试（那不是拒答场景）
    expect(qwenCreate).not.toHaveBeenCalled();
    expect(contents.join('')).toContain('无法直接访问');
  });
});