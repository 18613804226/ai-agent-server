import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_EXTS,
  VIDEO_EXTS,
  extractDocumentText,
  isDocumentExt,
  isVideoExt,
} from './document-text';

const mk = (name: string, text: string, mime = 'text/plain') => ({
  buffer: Buffer.from(text, 'utf8'),
  originalname: name,
  mimetype: mime,
});

describe('document-text：类型判定', () => {
  it('文档与视频扩展名互不重叠', () => {
    for (const ext of DOCUMENT_EXTS) {
      expect(VIDEO_EXTS).not.toContain(ext);
      expect(isDocumentExt(ext)).toBe(true);
    }
    for (const ext of VIDEO_EXTS) {
      expect(DOCUMENT_EXTS).not.toContain(ext);
      expect(isVideoExt(ext)).toBe(true);
    }
  });

  it('覆盖常见文档、代码与视频格式', () => {
    expect(isDocumentExt('.pdf')).toBe(true);
    expect(isDocumentExt('.docx')).toBe(true);
    expect(isDocumentExt('.doc')).toBe(true);
    expect(isDocumentExt('.ts')).toBe(true);
    expect(isDocumentExt('.md')).toBe(true);
    expect(isVideoExt('.mp4')).toBe(true);
    expect(isVideoExt('.mov')).toBe(true);
    expect(isVideoExt('.mkv')).toBe(true);
    expect(isDocumentExt('.mp4')).toBe(false);
    expect(isVideoExt('.pdf')).toBe(false);
  });
});

describe('document-text：文本提取', () => {
  it('文本/代码文件直接按 UTF-8 读取', async () => {
    const code = 'function hi() {\n  return "你好";\n}';
    const out = await extractDocumentText(mk('a.ts', code));
    expect(out).toBe(code);
  });

  it('剥离 NUL 字符（PG text/jsonb 不接受 0x00）', async () => {
    const out = await extractDocumentText(mk('a.txt', 'abc\u0000def'));
    expect(out).toBe('abcdef');
  });

  it('扩展名不在白名单但 mimetype 是 text/* 也按文本读', async () => {
    const out = await extractDocumentText(
      mk('weird.xyz', 'hello', 'text/plain'),
    );
    expect(out).toBe('hello');
  });

  it('不支持的类型返回空串而不是抛错', async () => {
    const out = await extractDocumentText(
      mk('a.xyz', 'binary', 'application/octet-stream'),
    );
    expect(out).toBe('');
  });
});
