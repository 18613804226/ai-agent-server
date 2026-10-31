/**
 * 集成测试：真实 PostgreSQL + pgvector 的「按 fileId 检索」验证。
 *
 * 这个文件**故意不放进默认单元测试**：
 * - 它会真实写入 DocumentChunk / KnowledgeFile
 * - 需要 DATABASE_URL 指向可用的本地库
 *
 * 单独跑： npm run test:integration
 * 没有配置 DB / key 时整组自动 skip（显示 skipped 而不是 failed）。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { VectorService } from '../../src/vector/vector.service';

const canRun = !!process.env.DATABASE_URL;

describe.skipIf(!canRun)('REAL retrieval-by-file verification', () => {
  let prisma: PrismaService;
  let vector: VectorService;
  let fileId: string;

  beforeAll(() => {
    // ✅ 懒构造：放在 import 期会因缺 key 直接抛错，导致整个文件都失败
    prisma = new PrismaService();
    vector = new VectorService(prisma);
    // 该用例只验证 pgvector 的距离计算与 enabled 过滤，不需要真调 embedding 接口
    vector.generateEmbedding = vi
      .fn()
      .mockResolvedValue(new Array(1024).fill(0.5));
    fileId = 'verify-' + Math.random().toString(16).slice(2, 10);
  });

  afterAll(async () => {
    await prisma.$executeRaw`
      DELETE FROM "DocumentChunk" WHERE (metadata->>'fileId') = ${fileId};
    `;
    await prisma.$executeRaw`
      DELETE FROM "KnowledgeFile" WHERE id = ${fileId};
    `;
    await prisma.$disconnect();
  });

  it('插入一条切片并按 fileId 检索得到它', async () => {
    const content = '知识库的特权密钥是 KILO_SECRET_42，仅此一份。';
    const metadata = { fileId, fileName: '诊断.txt', chunkIndex: 0 };
    await prisma.$executeRaw`
      INSERT INTO "KnowledgeFile"
        (id, "fileName", "mimeType", size, path, status, enabled, "totalChunks", "processedChunks")
      VALUES
        (${fileId}, '诊断.txt', 'text/plain', 1, '/tmp/verify.txt', 'indexed', true, 1, 1)
    `;
    await prisma.$executeRaw`
      INSERT INTO "DocumentChunk" (id, content, metadata, embedding)
      VALUES (gen_random_uuid(), ${content}, ${PrismaRaw(metadata)}::jsonb, ${PrismaVec(1024, 0.5)}::vector)
    `;

    const results = await vector.searchSimilarByFile('密钥是多少', [fileId]);
    console.log('=== 检索结果', results.length, '条 ===');
    console.log('=== 命中内容', JSON.stringify(results[0]?.content));
    console.log('=== metadata.fileId', results[0]?.metadata);

    expect(results.length).toBeGreaterThan(0);
    expect(
      String(results[0].metadata?.fileId ?? results[0]?.metadata?.fileId),
    ).toBe(fileId);

    await prisma.$executeRaw`
      UPDATE "KnowledgeFile" SET enabled = false WHERE id = ${fileId};
    `;
    expect(
      await vector.searchSimilarByFile('密钥是多少', [fileId]),
    ).toHaveLength(0);

    await prisma.$executeRaw`
      UPDATE "KnowledgeFile" SET enabled = true WHERE id = ${fileId};
    `;
    expect(
      await vector.searchSimilarByFile('密钥是多少', [fileId]),
    ).toHaveLength(1);
  }, 30000);
});

function PrismaRaw(o: object) {
  return JSON.stringify(o);
}
function PrismaVec(dim: number, v: number) {
  return '[' + new Array(dim).fill(v).join(',') + ']';
}
