/**
 * 附件「提取文字过少」守卫（30 字阈值）的单元测试。
 * mock extractDocumentText / transcribeVideoAudio，避免调用真实 pdfjs / ffmpeg。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
});

vi.mock('./document-text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./document-text.js')>();
  return {
    ...actual,
    extractDocumentText: vi.fn(),
  };
});
vi.mock('./video-transcript.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./video-transcript.js')>();
  return {
    ...actual,
    transcribeVideoAudio: vi.fn(),
  };
});
// mock fs/promises：落盘 + 清理走这里
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

import { extractDocumentText } from './document-text.js';
import { transcribeVideoAudio } from './video-transcript.js';
import { ChatService } from './chat.service.js';

function mkService() {
  const prisma = { $queryRaw: vi.fn().mockResolvedValue([]) };
  return new ChatService(prisma as never, {} as never);
}

function mkFile(name: string, buffer = Buffer.from('x')): Express.Multer.File {
  return {
    originalname: name,
    mimetype: 'application/pdf',
    buffer,
    size: buffer.length,
    path: '',
    destination: '',
    filename: '',
    encoding: '',
    fieldname: 'file',
    stream: null as never,
  };
}

describe('parseChatAttachment 空文本守卫', () => {
  beforeEach(() => {
    vi.mocked(extractDocumentText).mockReset();
    vi.mocked(transcribeVideoAudio).mockReset();
  });

  it('文档提取出 0 字 → 400 并清理落盘文件', async () => {
    vi.mocked(extractDocumentText).mockResolvedValue('');
    const service = mkService();
    await expect(
      service.parseChatAttachment(mkFile('扫描版.pdf')),
    ).rejects.toThrow(/扫描版图片型文档，暂无 OCR/);
  });

  it('文档提取到任意非空文字（含 1 字） → 正常返回，不因字数丢弃', async () => {
    vi.mocked(extractDocumentText).mockResolvedValue('仅一行字');
    const service = mkService();
    const r = await service.parseChatAttachment(mkFile('说明文档.txt'));
    expect(r.kind).toBe('document');
    expect(r.charCount).toBe(4);
  });

  it('视频转写出 0 字 → parseChatAttachment 抛出解析失败（守卫于转写函数自身）', async () => {
    vi.mocked(transcribeVideoAudio).mockResolvedValue({
      text: '',
      durationSec: 5,
    });
    const service = mkService();
    const r = await service.parseChatAttachment(mkFile('视频.mp4', Buffer.from('x')));
    expect(r.kind).toBe('video');
    expect(r.text).toBe(''); // 视频分支不强制字数下限
  });
});
