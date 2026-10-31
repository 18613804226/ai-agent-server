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
import ExcelJS from 'exceljs';

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
  '.pdf', '.doc', '.docx', '.xlsx',
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

  if (ext === '.xlsx') {
    try {
      return await extractXlsxText(file);
    } catch (e: any) {
      console.error(
        `document-text: 解析 XLSX 失败 ${file.originalname}:`,
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

/**
 * 把 exceljs 单元格值转成可读文本（公式取结果、错误取码、富文本/超链接取文字）。
 * 与 excel-check 的 normalizeCell 同形，但这里只要纯文本、不要结构，故单独轻量实现。
 */
function xlsxCellToText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'boolean') return raw ? 'TRUE' : 'FALSE';
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const obj = raw as Record<string, any>;
    if (obj.error) return String(obj.error);
    // 公式取缓存结果；result 可能仍是对象（如富文本），递归一次即可
    if (typeof obj.formula === 'string') return xlsxCellToText(obj.result);
    if (Array.isArray(obj.richText))
      return obj.richText.map((r: any) => r?.text ?? '').join('');
    if (obj.hyperlink) return String(obj.text ?? obj.hyperlink);
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

/**
 * .xlsx → 每张工作表一段文本：表名 + 行（单元格用制表符分隔）。
 * 上限 500 行/表，避免大表抽出超长文本撑爆 prompt（外层 buildAttachmentContext 还会再按 token 截断）。
 * 仅 .xlsx；老版 .xls（BIFF）exceljs 不支持，由调用方拒绝。
 */
async function extractXlsxText(file: ParsableFile): Promise<string> {
  const wb = new ExcelJS.Workbook();
  // exceljs 声明入参是旧版 Buffer<ArrayBuffer>，与 @types/node 的 Buffer 在类型层不兼容，运行时一致
  await wb.xlsx.load(file.buffer as unknown as any);

  const parts: string[] = [];
  wb.eachSheet((ws) => {
    const rows = ws.rowCount || 0;
    const cols = Math.max(1, ws.columnCount || 1);
    const rowLimit = Math.min(rows, 500);
    if (rowLimit === 0) return;
    parts.push(`【工作表：${ws.name}】`);
    for (let r = 1; r <= rowLimit; r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= cols; c++) {
        cells.push(xlsxCellToText(row.getCell(c).value));
      }
      // 整行空：跳过，省 token
      if (cells.every((s) => s === '')) continue;
      parts.push(cells.join('\t'));
    }
  });
  return parts.join('\n').replace(/\u0000/g, '');
}

/**
 * 把 .docx 转成 HTML 片段（不含 <html> 外壳），用于在线预览。
 * 图片用 mammoth 内置 dataUri 转换器内联成 data URI，HTML 自包含、WebView 无需回拉。
 * 仅 .docx 可转；老版 .doc 见 convertDocToHtml。
 *
 * @throws mammoth 解析失败时抛错（调用方应捕获后提示「无法预览」）
 */
export async function convertDocxToHtml(buffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml(
    { buffer },
    { convertImage: mammoth.images.dataUri },
  );
  return (result.value || '').replace(/\u0000/g, '');
}

/**
 * 把纯文本转成可预览的 HTML 片段：HTML 转义 + 按空行分段包 <p>，段内换行转 <br>。
 * 仅用于老版 .doc（word-extractor 只能取文本，无排版/表格/图片），凑一个「能读」的预览。
 */
export function docTextToHtml(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${escape(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * 老版 .doc → 纯文本 HTML 片段（word-extractor 取正文再转义分段）。
 * 无排版/表格/图片，仅「可读」预览。
 *
 * @throws 非 .doc 二进制或解析失败时抛错（调用方据此返回 415 回退下载）
 */
export async function convertDocToHtml(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return docTextToHtml((doc.getBody() || '').replace(/\u0000/g, ''));
}

/** HTML 转义（预览用：单元格内容不可信，防止 < > & " 注入标签） */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/**
 * .xlsx → HTML 表格（每个工作表一个 section + table），供 WebView 在线预览。
 * 单元格用 exceljs 值转文本后做 HTML 转义（不信任内容）。
 * 每表最多 maxRowsPerSheet 行，超出给截断提示，避免超大表把 HTML 撑爆。
 * 仅 .xlsx；老版 .xls（BIFF）exceljs 不支持，由调用方 415 回退下载。
 *
 * @throws 非 .xlsx 二进制解析失败时抛错（调用方据此返回 415）
 */
export async function convertXlsxToHtml(
  buffer: Buffer,
  maxRowsPerSheet = 1000,
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as any);

  const sections: string[] = [];
  wb.eachSheet((ws) => {
    const rows = ws.rowCount || 0;
    const cols = Math.max(1, ws.columnCount || 1);
    const limit = Math.min(rows, maxRowsPerSheet);
    const name = escapeHtml(ws.name);
    if (limit === 0) {
      sections.push(
        `<section class="xl-sheet"><h3 class="xl-sheet-name">${name}</h3><p class="xl-empty">（空工作表）</p></section>`,
      );
      return;
    }
    const trs: string[] = [];
    for (let r = 1; r <= limit; r++) {
      const row = ws.getRow(r);
      const tds: string[] = [];
      for (let c = 1; c <= cols; c++) {
        tds.push(`<td>${escapeHtml(xlsxCellToText(row.getCell(c).value))}</td>`);
      }
      trs.push(`<tr>${tds.join('')}</tr>`);
    }
    const note =
      rows > limit
        ? `<p class="xl-note">（仅显示前 ${limit} 行，共 ${rows} 行）</p>`
        : '';
    sections.push(
      `<section class="xl-sheet"><h3 class="xl-sheet-name">${name}</h3><table class="sheet">${trs.join('')}</table>${note}</section>`,
    );
  });
  if (!sections.length) return '<p class="xl-empty">（空工作簿）</p>';
  return sections.join('').replace(/\u0000/g, '');
}
