import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { rm } from 'fs/promises';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';
import { VectorService } from '../vector/vector.service';

const CN = '测试文档-年度报告.txt';

// 手造 multipart：filename 以 UTF-8 字节写入头，和浏览器一致
function buildMultipart(filename: string, content: Buffer) {
  const boundary = '----kbtest' + Math.random().toString(16).slice(2);
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/plain\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    body: Buffer.concat([
      Buffer.from(head, 'utf8'),
      content,
      Buffer.from(tail, 'utf8'),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('知识库上传：中文文件名 + 进度', () => {
  let app: INestApplication;
  const createdPaths: string[] = [];
  let lastCreated: any;

  const mockPrisma: any = {
    knowledgeFile: {
      create: async ({ data }: any) => {
        const rec = {
          id: 'kb-test-' + Math.random().toString(16).slice(2, 8),
          ...data,
        };
        lastCreated = rec;
        createdPaths.push(data.path);
        return rec;
      },
      update: async () => lastCreated,
      findUnique: async () => lastCreated,
      findMany: async () => [lastCreated],
      delete: async () => ({}),
    },
  };

  const mockVector: any = {
    addDocument: async () => {},
    deleteChunksByFile: async () => 0,
    searchSimilar: async () => [],
    searchSimilarByFile: async () => [],
    generateEmbedding: async () => [0.1],
  };

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        ChatService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: VectorService, useValue: mockVector },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    // 仅清理本测试创建的存根文件，绝不触碰其它（如用户上传的）文件
    await Promise.all(createdPaths.map((p) => rm(p, { force: true })));
  });

  async function upload(filename: string) {
    const { body, contentType } = buildMultipart(
      filename,
      Buffer.from('hello world'),
    );
    return request(app.getHttpServer())
      .post('/chat/knowledge/upload')
      .set('Content-Type', contentType)
      .send(body);
  }

  it('UTF-8 字节文件名返回正确', async () => {
    const res = await upload(CN);
    expect(res.status).toBe(201);
    expect(res.body.fileName).toBe(CN);
    expect(res.body.status).toBe('processing');
    expect(res.body.totalChunks).toBeGreaterThanOrEqual(1);
    expect(res.body.processedChunks).toBe(0);
  });

  it('进度接口返回结构化进度', async () => {
    const res = await request(app.getHttpServer()).get(
      `/chat/knowledge/files/${lastCreated.id}/progress`,
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(lastCreated.id);
    expect(res.body.fileName).toBe(CN);
    expect(typeof res.body.progress).toBe('number');
  });

  it('百分号编码的文件名能被正确恢复', async () => {
    const percent = encodeURIComponent(CN);
    expect(percent).not.toBe(CN); // 确保确实被编码过
    const res = await upload(percent);
    expect(res.status).toBe(201);
    expect(res.body.fileName).toBe(CN);
  });
});
