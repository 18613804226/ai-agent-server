import { PrismaService } from '../prisma/prisma.service';
import { VectorService } from './vector.service';

describe('REAL retrieval-by-file verification', () => {
  const prisma = new PrismaService();
  const vector = new VectorService(prisma);
  vector.generateEmbedding = vi.fn().mockResolvedValue(new Array(1024).fill(0.5));
  const fileId = 'verify-' + Math.random().toString(16).slice(2, 10);

  afterAll(async () => {
    await prisma.$executeRaw`
      DELETE FROM "DocumentChunk" WHERE (metadata->>'fileId') = ${fileId};
    `;
    await prisma.$disconnect();
  });

  it('插入一条切片并按 fileId 检索得到它', async () => {
    const content = '知识库的特权密钥是 KILO_SECRET_42，仅此一份。';
    const metadata = { fileId, fileName: '诊断.txt', chunkIndex: 0 };
    await prisma.$executeRaw`
      INSERT INTO "DocumentChunk" (id, content, metadata, embedding)
      VALUES (gen_random_uuid(), ${content}, ${PrismaRaw(metadata)}::jsonb, ${PrismaVec(1024, 0.5)}::vector)
    `;

    const results = await vector.searchSimilarByFile('密钥是多少', [fileId]);
    console.log('=== 检索结果', results.length, '条 ===');
    console.log('=== 命中内容', JSON.stringify(results[0]?.content));
    console.log('=== metadata.fileId', results[0]?.metadata);

    expect(results.length).toBeGreaterThan(0);
    expect(String(results[0].metadata?.fileId ?? results[0]?.metadata?.fileId)).toBe(
      fileId,
    );
  }, 30000);
});

function PrismaRaw(o: object) {
  return JSON.stringify(o);
}
function PrismaVec(dim: number, v: number) {
  return '[' + new Array(dim).fill(v).join(',') + ']';
}
