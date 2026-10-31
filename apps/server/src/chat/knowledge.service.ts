import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join, extname } from 'path';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import { extractDocumentText } from './document-text.js';
import { decodeOriginalName } from './filename.js';

/**
 * 知识库：上传落盘、切分、后台向量化、进度查询、启用开关与删除。
 * 与聊天附件完全隔离（files/knowledge/，会进 RAG）。
 */
@Injectable()
export class KnowledgeService {
  // ✅ 存到 uploads/ 之外，uploads/ 由 useStaticAssets 静态暴露，
  //    放这里会被当成静态文件外链、且接受任意后缀名容易导到存储型 XSS / 敏感文件公开。
  private readonly knowledgeDir = join(process.cwd(), 'files', 'knowledge');
  private readonly MAX_KB_FILE_SIZE = 10 * 1024 * 1024; // 10MB，超过就直接拒绝
  private readonly MAX_KB_CHUNKS = 500; // 超上只向量化前 N 段，防 LLM 被疯狒
  private readonly chunkSize = 500; // 每个切片目标字数
  private readonly chunkOverlap = 50; // 相邻切片重叠字数，减少边界信息丢失

  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorService: VectorService,
  ) {}

  // ✅ 剥离服务器端存储路径，不对外暴露 filesystem 路径
  private kbPublic(record: any): any {
    const { path: _path, ...rest } = record;
    return rest;
  }

  // ✅ 先把文本按空行拆成段落，保留原始结构；段落内再按句子边界切分，避免硬切
  private splitText(text: string): string[] {
    const chunks: string[] = [];
    const trimmed = text.trim();
    if (!trimmed) return [];

    const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim());

    for (const para of paragraphs) {
      const p = para.trim();
      if (p.length <= this.chunkSize) {
        chunks.push(p);
        continue;
      }

      let start = 0;
      while (start < p.length) {
        let end = start + this.chunkSize;
        if (end >= p.length) {
          chunks.push(p.slice(start));
          break;
        }

        let cut = end;
        const lookAround = 80;
        const segStart = Math.max(start, end - lookAround);
        const segEnd = Math.min(p.length, end + lookAround);
        let lastPunct = -1;
        for (let i = segEnd - 1; i >= segStart; i--) {
          const ch = p[i];
          if (
            ch === '。' ||
            ch === '！' ||
            ch === '？' ||
            ch === '；' ||
            ch === '\n'
          ) {
            lastPunct = i + 1;
            break;
          }
        }
        if (lastPunct > start) cut = lastPunct;
        else {
          const lastSpace = p.lastIndexOf(' ', end);
          if (lastSpace > start) cut = lastSpace;
        }

        chunks.push(p.slice(start, cut));
        const next = cut - this.chunkOverlap;
        start = next > start ? next : cut;
      }
    }

    return chunks;
  }

  // ✅ 文本抽取：文本类直接读；PDF 用 pdf-parse；DOCX 用 mammoth；老版 DOC 用 word-extractor；其他二进制仅存档不向量化
  // ✅ 解析逻辑与聊天附件共用（见 document-text.ts），这里只做一层委托
  private async extractText(file: Express.Multer.File): Promise<string> {
    return extractDocumentText(file);
  }

  // ✅ 上传知识库文件：落盘 + 建记录，随后【后台】逐片向量化并写进度
  async uploadKnowledgeFile(file: Express.Multer.File): Promise<any> {
    if (!file?.buffer) throw new BadRequestException('没有收到文件');
    if (file.size > this.MAX_KB_FILE_SIZE) {
      throw new BadRequestException(
        `文件过大，最多 ${this.MAX_KB_FILE_SIZE / 1024 / 1024}MB`,
      );
    }
    // ✅ 先修正乱码文件名，后面落库/日志都用修正后的名字
    file.originalname = decodeOriginalName(file.originalname);
    await mkdir(this.knowledgeDir, { recursive: true });

    const ext = extname(file.originalname).toLowerCase();
    const storedName = `kb-${Date.now()}-${randomUUID()}${ext}`;
    const storedPath = join(this.knowledgeDir, storedName);
    await writeFile(storedPath, file.buffer);

    const text = await this.extractText(file);
    const chunks = text.trim() ? this.splitText(text) : [];
    const limitedChunks = chunks.slice(0, this.MAX_KB_CHUNKS);
    if (chunks.length > limitedChunks.length) {
      console.warn(
        `splitText: 分片数 ${chunks.length} 超过上限 ${this.MAX_KB_CHUNKS}，仅向量化前 ${this.MAX_KB_CHUNKS} 段`,
      );
    }

    const record = await this.prisma.knowledgeFile.create({
      data: {
        fileName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        path: storedPath,
        // 有文本待向量化则 processing，否则仅存档
        status: limitedChunks.length ? 'processing' : 'uploaded',
        totalChunks: limitedChunks.length,
        processedChunks: 0,
      },
    });

    // 二进制/不可解析：仅存档不向量化，直接返回
    if (!limitedChunks.length) return this.kbPublic(record);

    // ✅ 后台异步向量化，不阻塞上传响应；前端轮询 progress 接口看进度
    void this.indexKnowledgeFile(record.id, limitedChunks, file.originalname);

    return this.kbPublic(record);
  }

  // ✅ 后台逐片生成向量并写库，按比例更新 processedChunks 进度
  private async indexKnowledgeFile(
    fileId: string,
    chunks: string[],
    fileName: string,
  ): Promise<void> {
    // 最多约 100 次进度写库，避免每片都 UPDATE
    const step = Math.max(1, Math.floor(chunks.length / 100));
    try {
      for (let i = 0; i < chunks.length; i++) {
        await this.vectorService.addDocument(chunks[i], {
          fileId,
          fileName,
          chunkIndex: i,
        });
        const processed = i + 1;
        if (processed % step === 0 || processed === chunks.length) {
          await this.prisma.knowledgeFile.update({
            where: { id: fileId },
            data: { processedChunks: processed },
          });
        }
      }
      await this.prisma.knowledgeFile.update({
        where: { id: fileId },
        data: { status: 'indexed', processedChunks: chunks.length },
      });
    } catch (e: any) {
      console.error('知识库向量化失败:', e?.message || e);
      await this.prisma.knowledgeFile.update({
        where: { id: fileId },
        data: { status: 'failed' },
      });
    }
  }

  // ✅ 查询单个文件的向量化进度（前端轮询用）
  async getKnowledgeFileProgress(id: string): Promise<any> {
    const file: any = await this.prisma.knowledgeFile.findUnique({
      where: { id },
    });
    if (!file) throw new NotFoundException(`KnowledgeFile not found: ${id}`);
    const total = file.totalChunks || 0;
    const processed = file.processedChunks || 0;
    return {
      id: file.id,
      fileName: file.fileName,
      status: file.status,
      totalChunks: total,
      processedChunks: processed,
      progress: total ? Math.round((processed / total) * 100) : 0,
    };
  }

  // ✅ 列出知识库文件（不返回服务端存储路径）
  async listKnowledgeFiles(): Promise<any[]> {
    const files = await this.prisma.knowledgeFile.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return files.map((f) => this.kbPublic(f));
  }

  async setKnowledgeFileEnabled(id: string, enabled: unknown): Promise<any> {
    if (typeof enabled !== 'boolean') {
      throw new BadRequestException('"enabled" 必须是布尔值');
    }

    const file = await this.prisma.knowledgeFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException(`KnowledgeFile not found: ${id}`);

    const updated = await this.prisma.knowledgeFile.update({
      where: { id },
      data: { enabled },
    });
    return this.kbPublic(updated);
  }

  // ✅ 删除知识库文件：删 DB 记录 + 向量切片 + 服务端文件
  async deleteKnowledgeFile(id: string): Promise<void> {
    const file = await this.prisma.knowledgeFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException(`KnowledgeFile not found: ${id}`);
    await this.prisma.knowledgeFile.delete({ where: { id } });
    await this.vectorService.deleteChunksByFile(id);
    await rm(file.path, { force: true });
  }
}
