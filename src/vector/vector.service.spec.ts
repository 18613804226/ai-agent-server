import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from './vector.service.js';

describe('向量检索的文档启用状态过滤', () => {
  const queryRaw = vi.fn().mockResolvedValue([]);
  let vector: VectorService;

  beforeEach(() => {
    process.env.OPENAI_API_KEY ||= 'test-key';
    queryRaw.mockClear();
    vector = new VectorService({
      $queryRaw: queryRaw,
    } as unknown as PrismaService);
    vector.generateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2]);
  });

  it('普通检索仅查询已启用知识库文件的切片', async () => {
    await vector.searchSimilar('query');

    const sql = queryRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('JOIN "KnowledgeFile"');
    expect(sql).toContain('k.enabled = true');
  });

  it('指定文件检索也排除已禁用知识库文件', async () => {
    await vector.searchSimilarByFile('query', ['file-id']);

    const sql = queryRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('JOIN "KnowledgeFile"');
    expect(sql).toContain('k.enabled = true');
  });
});
