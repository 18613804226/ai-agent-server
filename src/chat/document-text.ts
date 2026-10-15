// src/chat/document-text.ts
/**
 * 文档文本提取（与知识库上传共用同一套解析逻辑）。
 *
 * 拆成独立模块的原因：聊天附件和知识库上传都要解析文档，
 * 但两者的去向完全不同 —— 知识库会向量化入库，聊天附件只注入当轮对话。
 * 解析逻辑放这里共享，避免复制两份。
 */
import { extname } from 'path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';

export interface ParsableFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/** 可直接按 UTF-8 读取的扩展名（含代码文件） */
export const DOC_TEXT_EXTS = [
  '.txt', '.md', '.json', '.csv', '.log', '.xml', '.html', '.htm',
  // 代码文件
  '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.sass', '.vue', '.svelte',
  '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.cs',
  '.php', '.rb', '.swift', '.kt', '.scala', '.lua', '.perl', '.r',
  '.yml', '.yaml', '.toml', '.ini', '.env', '.conf', '.gitignore',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.proto',
  '.bat', '.ps1',
];

/** 这些扩展名认为是「文档」（可解析成文本给模型看） */
export const DOCUMENT_EXTS = [
  '.pdf', '.doc', '.docx',
  ...DOC_TEXT_EXTS.filter((e) => !['.env', '.gitignore'].includes(e)),
];

/**
 * 视频扩展名（走音轨转写，见 video-transcript.ts）。
 * ⚠️ 故意不含 `.ts`：它同时是 TypeScript 扩展名。有歧义时以 mimetype 为准
 * （真视频一定是 video/mp2t，TS 源码则是 text/plain 之类），避免把代码文件当视频。
 */
export const VIDEO_EXTS = [
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.m4v', '.wmv', '.mts', '.m2ts',
];

export function isDocumentExt(ext: string): boolean {
  return DOCUMENT_EXTS.includes(ext.toLowerCase());
}

export function isVideoExt(ext: string): boolean {
  return VIDEO_EXTS.includes(ext.toLowerCase());
}

/**
 * 解析失败返回空串而不是抛错：调用方提示「解析不出内容」比让整轮对话失败更友好。
 *
 * ⚠️ 扫描版/纯图片 PDF 对此仍无能：pdf-parse 只能拿到零星 metadata。
 *   降级 OCR 见 docs/ocr-backlog.md。
 */
export async function extractDocumentText(
  file: ParsableFile,
): Promise<string> {
  const ext = extname(file.originalname || '').toLowerCase();
  const isText =
    (file.mimetype || '').startsWith('text/') || DOC_TEXT_EXTS.includes(ext);

  if (isText) {
    // ✅ NUL 会让 PostgreSQL 报 22021；附件不进库，但仍统一清掉避免模型侧异常
    return file.buffer.toString('utf8').replace(/\u0000/g, '');
  }

  if (ext === '.pdf') {
    try {
      const pdf = new PDFParse({ data: file.buffer });
      // ⚠️ pdf-parse 默认会在每页正文后插入 `-- N of M --` 页码分隔符，
      //    纯噪声会被当正文喂给大模型（实测 4 字文档变成 20 字瞎内容）。
      //    pageJoiner: '' → 只按空行拼接正文。
      const textResult = await pdf.getText({ pageJoiner: '' });
      await pdf.destroy();
      return (textResult.text || '').replace(/\u0000/g, '');
    } catch (e: any) {
      console.error(
        `document-text: 解析 PDF 失败 ${file.originalname}:`,
        e?.message || e,
      );
      return '';
    }
  }

  if (ext === '.docx') {
    try {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      return (result.value || '').replace(/\u0000/g, '');
    } catch (e: any) {
      console.error(
        `document-text: 解析 DOCX 失败 ${file.originalname}:`,
        e?.message || e,
      );
      return '';
    }
  }

  if (ext === '.doc') {
    try {
      const extractor = new WordExtractor();
      const doc = await extractor.extract(file.buffer);
      return (doc.getBody() || '').replace(/\u0000/g, '');
    } catch (e: any) {
      console.error(
        `document-text: 解析 DOC 失败 ${file.originalname}:`,
        e?.message || e,
      );
      return '';
    }
  }

  console.warn(
    `document-text: 不支持的文件类型 ${file.originalname}（${file.mimetype}）`,
  );
  return '';
}
