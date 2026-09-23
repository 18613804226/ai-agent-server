// src/vector/vector.service.ts
import { Injectable } from '@nestjs/common';
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
      model: 'text-embedding-v3', // 或者是你选用的 embedding 模型
      input: text,
      dimensions: 1024,
    });
    return response.data[0].embedding;
  }

  // 2. 写入带有向量的文档切片
  async addDocument(content: string, metadata: any) {
    try {
      const embedding = await this.generateEmbedding(content);
      const vectorString = `[${embedding.join(',')}]`;

      // 通过 Prisma 原生 SQL 写入向量
      await this.prisma.$executeRaw`
      INSERT INTO "DocumentChunk" (id, content, metadata, embedding)
      VALUES (gen_random_uuid(), ${content}, ${metadata}::jsonb, ${vectorString}::vector)
    `;
    } catch (error: any) {
      console.error('添加文档切片并生成向量失败:', error.message || error);
      // 💡 抛出一个清晰的错误，让外层或前端能够捕获到提示
      throw new Error(`向量化失败: ${error.message || '未知错误'}`);
    }
  }

  // 3. 核心：语义向量相似度检索 (KNN 检索)
  async searchSimilar(queryText: string, limit = 5) {
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

    return results;
  }
}
