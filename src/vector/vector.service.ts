// src/vector/vector.service.ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import OpenAI from 'openai';

@Injectable()
export class VectorService {
  private openai: OpenAI;

  constructor(private prisma: PrismaService) {
    // 💡 在构造函数中初始化 OpenAI，确保此时环境变量已经生效
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || '',
      baseURL: process.env.OPENAI_BASE_URL || '',
    });
  }

  // 1. 将文本转化为 1024 维向量
  async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: 'qwen3.7-text-embedding-flash', // 或者是你选用的 embedding 模型
      input: text,
      dimensions: 1024,
    });
    return response.data[0].embedding;
  }

  // 2. 写入带有向量的文档切片
  async addDocument(content: string, metadata: any) {
    try {
      // ⚠️ PostgreSQL 的 text/jsonb 都不接受 NUL(0x00)。老版 .doc、扫描件 PDF、或其实是二进制的
      //    "text/*" 文件抽出的文本常混入 NUL，直接 INSERT 会报 22021「无效的 UTF8 编码字节顺序: 0x00」。
      //    在生成向量之前就清洗，避免把脏文本喂给 embedding。
      const safeContent = this.stripNul(content);
      const safeMetadata = this.sanitizeMetadata(metadata ?? {});
      const embedding = await this.generateEmbedding(safeContent);
      const vectorString = `[${embedding.join(',')}]`;

      // 通过 Prisma 原生 SQL 写入向量
      await this.prisma.$executeRaw`
      INSERT INTO "DocumentChunk" (id, content, metadata, embedding)
      VALUES (gen_random_uuid(), ${safeContent}, ${safeMetadata}::jsonb, ${vectorString}::vector)
    `;
    } catch (error: any) {
      console.error('添加文档切片并生成向量失败:', error.message || error);
      // 💡 抛出一个清晰的错误，让外层或前端能够捕获到提示
      throw new Error(`向量化失败: ${error.message || '未知错误'}`);
    }
  }

  // 剔除 PostgreSQL text 不能接受的 NUL(0x00)
  private stripNul(text: string): string {
    return text.replaceAll('\u0000', '');
  }

  // metadata 走 ::jsonb，同样不能含 NUL，递归清洗所有字符串值
  private sanitizeMetadata(value: unknown): unknown {
    if (typeof value === 'string') return this.stripNul(value);
    if (Array.isArray(value)) return value.map((v) => this.sanitizeMetadata(v));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          this.sanitizeMetadata(v),
        ]),
      );
    }
    return value;
  }

  // 3. 核心：语义向量相似度检索 (KNN 检索)
  async searchSimilar(queryText: string, limit = 5): Promise<any[]> {
    const queryEmbedding = await this.generateEmbedding(queryText);
    const vectorString = `[${queryEmbedding.join(',')}]`;

    // 使用 pgvector 的余弦距离操作符 (<=>) 进行高性能相似度计算
    const results = await this.prisma.$queryRaw`
      SELECT id, content, metadata, 
             1 - (embedding <=> ${vectorString}::vector) as similarity
      FROM "DocumentChunk"
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorString}::vector ASC
      LIMIT ${limit};
    `;

    return results as any[];
  }

  // ✅ 按知识库文件 ID 限定检索范围（仅检索指定文件切片），用于文件级 RAG
  async searchSimilarByFile(
    queryText: string,
    fileIds: string[],
    limit = 5,
  ): Promise<any[]> {
    const queryEmbedding = await this.generateEmbedding(queryText);
    const vectorString = `[${queryEmbedding.join(',')}]`;

    const results = await this.prisma.$queryRaw`
      SELECT id, content, metadata,
             1 - (embedding <=> ${vectorString}::vector) as similarity
      FROM "DocumentChunk"
      WHERE embedding IS NOT NULL
        AND (metadata->>'fileId') IN (${Prisma.join(fileIds, ',')})
      ORDER BY embedding <=> ${vectorString}::vector ASC
      LIMIT ${limit};
    `;
    return results as any[];
  }

  // ✅ 删除某个知识库文件下的所有切片（文件删除时同步清理）
  async deleteChunksByFile(fileId: string): Promise<number> {
    const result: any = await this.prisma.$executeRaw`
      DELETE FROM "DocumentChunk"
      WHERE (metadata->>'fileId') = ${fileId}
    `;
    return (result?.count ?? 0) as number;
  }
}
