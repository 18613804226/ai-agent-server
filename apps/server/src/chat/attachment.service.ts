import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join, resolve, sep, extname } from 'path';
import { PrismaService } from '../prisma/prisma.service.js';
import { estimateTokens } from './chat-prompt.js';
import { decodeOriginalName } from './filename.js';
import {
  AttachmentStore,
  type AttachmentKind,
  type ChatAttachment,
} from './attachment-store.js';
import {
  extractDocumentText,
  isDocumentExt,
  isVideoExt,
  convertDocxToHtml,
  convertDocToHtml,
  convertXlsxToHtml,
} from './document-text.js';
import {
  transcribeVideoAudio,
  VideoNoAudioError,
  VideoTooLongError,
} from './video-transcript.js';
import {
  checkExcelBuffer,
  formatExcelFindingsForModel,
  type ExcelCheckResult,
} from './excel-check.js';

/**
 * 聊天附件：上传解析、落盘、内存缓存、预览、删除与 TTL 清扫。
 * 与知识库完全隔离（files/chat-attachments/，不做向量化、不进 RAG）。
 */
@Injectable()
export class AttachmentService {
  /** 附件原始文件目录（30 天 TTL 清扫） */
  private readonly attachmentDir = join(
    process.cwd(),
    'files',
    'chat-attachments',
  );
  /** 附件原始文件保留天数（默认 30 天，仅删「未被任何消息引用」的） */
  private readonly attachmentRetainMs =
    Number(process.env.ATTACHMENT_RETAIN_DAYS ?? 30) * 24 * 60 * 60 * 1000;
  /** 附件临时存储：只进内存、不走向量库，到期即弃 */
  private readonly attachmentStore = new AttachmentStore();
  /** 聊天附件大小上限（视频音轨要过 ffmpeg + ASR，比知识库宽松些） */
  private readonly MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;
  /** 视频时长上限：超过直接拒绝，避免一次请求烧穿 token 预算 */
  private readonly MAX_VIDEO_DURATION_SEC = 600;
  /** 附件文本注入上限（token）：防一份年报把整个 prompt 撑爆 */
  private readonly MAX_ATTACHMENT_TOKENS = 4000;

  /** 视频转写用的 ASR 回调，由 ChatService 注入（避免附件模块依赖语音实现） */
  private asrRunner?: (wavPath: string) => Promise<string>;

  constructor(private readonly prisma: PrismaService) {
    this.attachmentStore.startSweeper();
    this.startAttachmentSweeper();
  }

  setAsrRunner(fn: (wavPath: string) => Promise<string>): void {
    this.asrRunner = fn;
  }

  validateChatAttachment(file: Express.Multer.File): void {
    if (!file?.buffer) throw new BadRequestException('没有收到文件');
    if (file.size > this.MAX_ATTACHMENT_SIZE) {
      throw new BadRequestException(
        `文件过大，最多 ${this.MAX_ATTACHMENT_SIZE / 1024 / 1024}MB`,
      );
    }
    const name = decodeOriginalName(file.originalname || '未命名文件');
    const ext = extname(name).toLowerCase();
    const mime = file.mimetype || '';
    // mimetype 优先：`.ts` 既是 TypeScript 也是 MPEG-TS 视频，靠 mimetype 才能分清
    const isVideo =
      mime.startsWith('video/') ||
      (isVideoExt(ext) && !mime.startsWith('text/'));
    const isDocument =
      !isVideo && (isDocumentExt(ext) || mime.startsWith('text/'));
    if (!isVideo && !isDocument) {
      throw new BadRequestException(
        `不支持的文件类型 ${ext || file.mimetype}，目前支持文档（pdf/doc/docx/xlsx/txt/md/代码等）与视频（mp4/mov/mkv 等）`,
      );
    }
  }

  /**
   * 解析聊天附件：**先把原始文件落盘**（供历史回看/重新提问），再抽文本。
   *
   * 落盘目录与知识库完全隔离：files/chat-attachments/ 不做向量化、不进 RAG，
   * 只是普通文件存储，靠 TTL 清扫回收。
   */
  async parseChatAttachment(file: Express.Multer.File): Promise<{
    id: string;
    fileRef: string;
    url: string;
    name: string;
    kind: AttachmentKind;
    text: string;
    charCount: number;
    durationSec?: number;
    /** .xlsx 专用：上传时默认跑一遍公式/数据质量检查，结果随附件回传 */
    excelCheck?: ExcelCheckResult;
  }> {
    this.validateChatAttachment(file);

    const name = decodeOriginalName(file.originalname || '未命名文件');
    const ext = extname(name).toLowerCase();
    const mime = file.mimetype || '';
    const isVideo =
      mime.startsWith('video/') ||
      (isVideoExt(ext) && !mime.startsWith('text/'));

    // 落盘：文件名用 uuid + 归一化后的扩展名（白名单外一律 bin，
    // 保证任何文件都可被服务、也可被 30 天清扫回收，不会变成永久垃圾）
    const id = randomUUID();
    const fileRef = `${id}.${this.attachmentExt(name)}`;
    await mkdir(this.attachmentDir, { recursive: true });
    await writeFile(join(this.attachmentDir, fileRef), file.buffer);

    const t0 = Date.now();
    const base = { id, fileRef, url: `/chat/attachments/${fileRef}`, name };

    if (isVideo) {
      let result;
      try {
        result = await transcribeVideoAudio(file.buffer, name, {
          maxDurationSec: this.MAX_VIDEO_DURATION_SEC,
          asr: (wavPath) => {
            if (!this.asrRunner) {
              return Promise.reject(new Error('ASR 未配置'));
            }
            return this.asrRunner(wavPath);
          },
        });
      } catch (e: any) {
        // 解析失败就把刚落的盘撤掉，别留看不懂的垃圾文件
        await this.removeAttachmentFile(fileRef);
        if (e instanceof VideoTooLongError || e instanceof VideoNoAudioError) {
          throw new BadRequestException(e.message);
        }
        throw new BadRequestException(`视频解析失败：${e?.message || e}`);
      }
      return {
        ...base,
        kind: 'video',
        text: result.text,
        charCount: result.text.length,
        durationSec: Math.round(result.durationSec),
      };
    }

    let text = (await extractDocumentText(file)).trim();
    // ✅ .xlsx 默认走一遍公式/数据质量检查：把结果报告拼在最前面注入上下文，
    //    用户不提问（默认指令「请概括上面的内容。」）也会先看到错误清单；
    //    原始数据表附在后面，用户追问具体数据时仍可用。
    let excelCheck: ExcelCheckResult | undefined;
    if (ext === '.xlsx') {
      try {
        excelCheck = await checkExcelBuffer(name, file.buffer);
        const report = formatExcelFindingsForModel(excelCheck);
        text = report + (text ? `\n\n【原始数据】\n${text}` : '');
      } catch (e: any) {
        // 检查失败不致命：退回纯文本，附件照常可用
        console.warn(`📊 xlsx 自动检查失败 ${name}:`, e?.message || e);
      }
    }
    if (!text) {
      await this.removeAttachmentFile(fileRef);
      throw new BadRequestException(
        `没能从 ${name} 解析出文字（可能是扫描版图片型文档，暂无 OCR）`,
      );
    }
    return {
      ...base,
      kind: 'document',
      text,
      charCount: text.length,
      excelCheck,
    };
  }

  /**
   * 把「随消息直传」解析出的附件也缓存进内存，
   * 这样同一会话内紧接着追问时不用重新解析（30 分钟后则靠磁盘复活兜底）。
   */
  rememberChatAttachment(parsed: {
    id: string;
    fileRef: string;
    name: string;
    kind: AttachmentKind;
    text: string;
    charCount: number;
    durationSec?: number;
  }): void {
    this.attachmentStore.set({
      id: parsed.id,
      name: parsed.name,
      kind: parsed.kind,
      text: parsed.text,
      charCount: parsed.charCount,
      durationSec: parsed.durationSec,
      fileRef: parsed.fileRef,
      createdAt: Date.now(),
    });
  }

  /**
   * 上传聊天附件（两步流）：解析后存进临时存储，返回 id 供后续 stream 引用。
   * 适合先预览确认再发送的交互。原始文件已落盘，30 天后才回收。
   */
  async uploadChatAttachment(file: Express.Multer.File) {
    const parsed = await this.parseChatAttachment(file);
    this.rememberChatAttachment(parsed);
    return {
      id: parsed.id,
      name: parsed.name,
      kind: parsed.kind,
      charCount: parsed.charCount,
      durationSec: parsed.durationSec,
      url: parsed.url,
      // .xlsx 会把上传时的自动检查结果一并回传，前端可即时渲染错误清单
      excelCheck: parsed.excelCheck,
    };
  }

  /**
   * 删除一份「预上传附件」（POST /chat/attachment 后、消息还没发送时的清理）。
   *
   * 安全设计（与删除上传图片同一口径）：
   * 1. 文件名必须匹配 ATTACHMENT_FILE_RE，否则 400（挡 `../` 穿越 / 非法后缀）
   * 2. 再走一次 resolve 兜底确认仍在 attachmentDir 内
   * 3. 被消息引用过的附件（Message.attachments 里有 fileRef）返回 409 拒绝删，
   *    宁可留孤儿也别把历史回显搞坏
   */
  async deleteChatAttachment(fileRef: string): Promise<void> {
    if (!AttachmentService.ATTACHMENT_FILE_RE.test(fileRef)) {
      throw new BadRequestException('非法文件名');
    }
    if (await this.isAttachmentReferenced(fileRef)) {
      throw new HttpException(
        '该附件已被消息引用，不能删除',
        HttpStatus.CONFLICT,
      );
    }
    const dir = resolve(this.attachmentDir);
    const filepath = resolve(this.attachmentDir, fileRef);
    if (!filepath.startsWith(dir + sep)) {
      throw new BadRequestException('非法文件名');
    }
    if (!existsSync(filepath)) {
      throw new NotFoundException('附件不存在或已过期删除');
    }
    try {
      await rm(filepath, { force: false });
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        throw new NotFoundException('附件不存在或已过期删除');
      }
      throw e;
    }
  }

  /** 附件 fileRef 是否已被某个 Message 引用（引用过的不能删） */
  private async isAttachmentReferenced(fileRef: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM "Message"
      WHERE "attachments" IS NOT NULL
        AND jsonb_typeof("attachments"::jsonb) = 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements("attachments"::jsonb) AS "elem"
          WHERE "elem"->>'fileRef' = ${fileRef}
        )
      LIMIT 1`;
    return rows.length > 0;
  }

  /**
   * 把本轮附件拼成注入 prompt 的文本块。
   * 超预算时按 token 估算截断（保留开头，通常标题和结论都在前面）。
   * 过期/不存在的 id 会带回来让调用方提示用户重新上传。
   *
   * @param inlineItems 随消息直传、已当场解析好的附件（单步流），优先于 id 引用的
   */
  buildAttachmentContext(
    attachmentIds?: string[],
    inlineItems?: Array<{
      id?: string;
      fileRef?: string;
      url?: string;
      name: string;
      kind: AttachmentKind;
      text: string;
      durationSec?: number;
    }>,
  ): {
    context: string;
    used: ChatAttachment[];
    missing: string[];
  } {
    // 内联附件（本轮直传）排在前面，再是按 id 引用的
    const found: ChatAttachment[] = (inlineItems ?? []).map((it) => ({
      id: it.id ?? it.fileRef ?? 'inline',
      name: it.name,
      kind: it.kind,
      text: it.text,
      charCount: it.text.length,
      durationSec: it.durationSec,
      fileRef: it.fileRef,
      createdAt: Date.now(),
    }));

    let missing: string[] = [];
    if (attachmentIds?.length) {
      const r = this.attachmentStore.getMany(attachmentIds);
      found.push(...r.found);
      missing = r.missing;
    }
    if (!found.length && !missing.length) {
      return { context: '', used: [], missing };
    }

    // 内存条目过期但文件还在盘上 → 重新解析「复活」，
    // 这样 30 天后回看历史消息仍能就同一份附件继续追问
    if (missing.length) {
      const revived = this.reviveAttachmentsFromDisk(missing);
      found.push(...revived);
      missing = missing.filter((id) => !revived.some((r) => r.id === id));
    }
    if (!found.length) {
      return { context: '', used: [], missing };
    }

    const blocks: string[] = [];
    let used: ChatAttachment[] = [];
    let consumed = 0;

    for (const item of found) {
      const kindLabel = item.kind === 'video' ? '视频转写' : '文档';
      const duration =
        item.durationSec != null ? `（时长 ${item.durationSec} 秒）` : '';
      const header = `【${kindLabel}：${item.name}${duration}】\n`;

      let body = item.text;
      // 逐份截断：这份超了就先砍这份，砍完还超才丢整份
      const budget = this.MAX_ATTACHMENT_TOKENS - consumed;
      if (estimateTokens(header + body) > budget) {
        body = body.slice(0, Math.max(0, budget * 4 - header.length));
      }
      consumed += estimateTokens(header + body);

      blocks.push(header + body);
      used.push(item);
      if (consumed >= this.MAX_ATTACHMENT_TOKENS) break;
    }

    return {
      context: blocks.join('\n\n'),
      used,
      missing,
    };
  }

  // ---------------- 附件文件：读取、复活、清扫 ----------------

  /** 删除一个附件文件（不存在也视为成功，配合创建/清空逻辑） */
  private async removeAttachmentFile(fileRef: string): Promise<void> {
    try {
      await rm(join(this.attachmentDir, fileRef), { force: true });
    } catch {
      /* 删不掉不阻塞主流程，交给 30 天清扫兜底 */
    }
  }

  /** 附件文件名规则：`<uuid>.<白名单扩展名>`，与落盘时一致 */
  private static readonly ATTACHMENT_EXTS = [
    // 文档
    'pdf',
    'doc',
    'docx',
    'xlsx',
    'txt',
    'md',
    'csv',
    'json',
    'log',
    'xml',
    // 图片
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'bmp',
    'avif',
    // 视频
    'mp4',
    'mov',
    'mkv',
    'avi',
    'webm',
    'flv',
    'm4v',
    'wmv',
    // 代码（按纯文本内联展示）
    'js',
    'ts',
    'py',
    'go',
    'java',
    'css',
    // 兜底：白名单外的一律存成 bin，只能下载不能渲染
    'bin',
  ];
  private static readonly ATTACHMENT_FILE_RE = new RegExp(
    `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(${AttachmentService.ATTACHMENT_EXTS.join('|')})$`,
    'i',
  );

  /**
   * 附件 mime 白名单。
   * ⚠️ 故意不含 text/html / image/svg+xml：这两类能以我们自己的 origin 渲染，
   *    等于存储型 XSS 通道；这类扩展名落盘时会被归一成 bin，只能下载。
   */
  private static readonly ATTACHMENT_MIME: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain; charset=utf-8',
    md: 'text/plain; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    json: 'application/json',
    log: 'text/plain; charset=utf-8',
    xml: 'text/xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
    flv: 'video/x-flv',
    m4v: 'video/x-m4v',
    wmv: 'video/x-ms-wmv',
    js: 'text/plain; charset=utf-8',
    ts: 'text/plain; charset=utf-8',
    py: 'text/plain; charset=utf-8',
    go: 'text/plain; charset=utf-8',
    java: 'text/plain; charset=utf-8',
    css: 'text/css; charset=utf-8',
  };

  /** 落盘用的扩展名：白名单内保留原样，白名单外一律 bin（保证文件可服务、可清扫） */
  private attachmentExt(fileName: string): string {
    const ext = extname(fileName || '')
      .toLowerCase()
      .replace(/^\./, '');
    return AttachmentService.ATTACHMENT_EXTS.includes(ext) ? ext : 'bin';
  }

  /**
   * 取一个附件文件用于返回给前端：校验文件名、限定在附件目录内、
   * 按扩展名白名单推 content-type（**不信任磁盘内容**，防存储型 XSS）。
   */
  async getAttachmentFile(
    fileRef: string,
  ): Promise<{ path: string; contentType: string; fileName: string }> {
    if (!AttachmentService.ATTACHMENT_FILE_RE.test(fileRef)) {
      throw new BadRequestException('非法文件名');
    }
    const path = resolve(this.attachmentDir, fileRef);
    if (!path.startsWith(resolve(this.attachmentDir) + sep)) {
      throw new BadRequestException('非法文件名');
    }
    if (!existsSync(path)) {
      throw new NotFoundException('附件不存在或已过期删除');
    }
    const ext = extname(fileRef).slice(1).toLowerCase();
    return {
      path,
      contentType:
        AttachmentService.ATTACHMENT_MIME[ext] || 'application/octet-stream',
      // 对外文件名统一用 uuid，不泄露原始文件名（附件名已在消息元数据里）
      fileName: fileRef,
    };
  }

  /**
   * 把 .docx 附件转成自包含 HTML（图片内联 data URI）供 WebView 在线预览。
   *
   * 安全：mammoth 输出的正文文本已转义，且包裹模板由我们掌控；
   *   控制器侧另加 CSP（禁脚本/禁外链）兜底，与「禁止直接以 text/html 直出磁盘文件」
   *   的既有策略不冲突 —— 本接口只对转换结果输出，不接受用户原始 HTML。
   *
   * .docx 走 mammoth（带排版/图片）；老版 .doc 走 word-extractor 纯文本 HTML（仅可读，
   * 无排版/图片）；.xlsx 走 exceljs 生成 HTML 表格；其余类型返回 415，前端回退下载。
   */
  async getAttachmentHtml(fileRef: string): Promise<string> {
    if (!AttachmentService.ATTACHMENT_FILE_RE.test(fileRef)) {
      throw new BadRequestException('非法文件名');
    }
    const path = resolve(this.attachmentDir, fileRef);
    if (!path.startsWith(resolve(this.attachmentDir) + sep)) {
      throw new BadRequestException('非法文件名');
    }
    const ext = extname(fileRef).slice(1).toLowerCase();
    if (ext !== 'docx' && ext !== 'doc' && ext !== 'xlsx') {
      throw new UnsupportedMediaTypeException(
        '该文件类型不支持在线预览，请下载后查看',
      );
    }
    if (!existsSync(path)) {
      throw new NotFoundException('附件不存在或已过期删除');
    }
    let body: string;
    try {
      const buf = await readFile(path);
      body =
        ext === 'docx'
          ? await convertDocxToHtml(buf)
          : ext === 'doc'
            ? await convertDocToHtml(buf)
            : await convertXlsxToHtml(buf);
    } catch (e: any) {
      console.error(`📄 文档预览转换失败 ${fileRef}:`, e?.message || e);
      throw new UnsupportedMediaTypeException('文档解析失败，无法预览');
    }
    return this.wrapPreviewHtml(body);
  }

  /** 包一层带基础样式（支持深色模式）的完整 HTML 文档 */
  private wrapPreviewHtml(body: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>文档预览</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.75;max-width:820px;margin:0 auto;padding:24px 16px;color:#1f2329;background:#fff;word-wrap:break-word;overflow-wrap:break-word;}
  img{max-width:100%;height:auto;}
  table{border-collapse:collapse;max-width:100%;}
  td,th{border:1px solid #ccc;padding:6px 10px;}
  h1,h2,h3,h4{line-height:1.4;}
  a{color:#2b6cb0;}
  .xl-sheet{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 24px;}
  .xl-sheet-name{font-size:14px;font-weight:600;color:#888;margin:0 0 8px;}
  table.sheet{font-size:13px;white-space:nowrap;max-width:none;}
  table.sheet td{border:1px solid #ddd;padding:4px 8px;}
  .xl-note{color:#999;font-size:12px;margin:6px 0 0;}
  .xl-empty{color:#999;}
  @media (prefers-color-scheme:dark){
    body{color:#e5eaf3;background:#1a1a1a;}
    td,th{border-color:#444;}
    a{color:#6fa8ff;}
    table.sheet td{border-color:#3a3a3a;}
    .xl-sheet-name,.xl-note,.xl-empty{color:#9aa0a6;}
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
  }

  /**
   * 内存条目过期后，尝试从磁盘重新解析附件（「复活」）。
   * 让用户 30 天内都能就历史消息里的同一份文件继续追问，不用重新上传。
   */
  private reviveAttachmentsFromDisk(ids: string[]): ChatAttachment[] {
    const out: ChatAttachment[] = [];
    const uuidIds = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!uuidIds.length) return out;

    // 目录只列一次，多个 id 共用；列失败（目录不存在）就当作没有可复活的
    let dirEntries: string[] = [];
    try {
      dirEntries = readdirSync(this.attachmentDir);
    } catch {
      return out;
    }

    for (const id of uuidIds) {
      try {
        const fileRef = dirEntries.find(
          (n) =>
            n.startsWith(`${id}.`) &&
            AttachmentService.ATTACHMENT_FILE_RE.test(n),
        );
        if (!fileRef) continue;

        const buffer = readFileSync(join(this.attachmentDir, fileRef));
        const parsed = this.parseAttachmentSync(buffer, fileRef);
        if (!parsed) continue;

        const item: ChatAttachment = {
          id,
          name: parsed.name,
          kind: parsed.kind,
          text: parsed.text,
          charCount: parsed.text.length,
          durationSec: parsed.durationSec,
          fileRef,
          createdAt: Date.now(),
        };
        // 顺手回填内存，短时间内的再次追问不用再解析
        this.attachmentStore.set(item);
        out.push(item);
        console.log(`📎 附件从磁盘复活: ${fileRef}（${parsed.kind}）`);
      } catch {
        /* 单个失败不影响其它 */
      }
    }
    return out;
  }

  /**
   * 同步解析（仅「复活」路径用）：视频转写需要异步 ASR，这里不支持，
   * 遇到视频只返回元信息 + 提示文本，不阻塞历史追问的降级体验。
   */
  private parseAttachmentSync(
    buffer: Buffer,
    fileRef: string,
  ): {
    name: string;
    kind: AttachmentKind;
    text: string;
    durationSec?: number;
  } | null {
    const ext = extname(fileRef).toLowerCase();
    const isVideo = isVideoExt(ext);
    if (isVideo) {
      // 视频转写要调 ASR，且可能几十秒；历史追问场景下降级为提示，不自动烧钱
      return {
        name: fileRef,
        kind: 'video',
        text: '（该视频的转写文本已不在内存中。请重新发送该视频以再次转写。）',
      };
    }
    const text = buffer.toString('utf8').replace(/\u0000/g, '');
    // PDF/DOCX 等二进制格式同步解析不了，只能提示
    if (
      !text.trim() ||
      /[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 1000))
    ) {
      return {
        name: fileRef,
        kind: 'document',
        text: '（该文档内容已从内存回收，请重新发送以解析。）',
      };
    }
    return { name: fileRef, kind: 'document', text: text.trim() };
  }

  /**
   * 清理超过保留期且**未被任何消息引用**的附件文件。
   * 双条件 AND：既不会删到正在用的，也不会让磁盘无限增长。
   */
  async sweepExpiredAttachments(): Promise<number> {
    if (!existsSync(this.attachmentDir)) return 0;
    const entries = readdirSync(this.attachmentDir).filter((n) =>
      AttachmentService.ATTACHMENT_FILE_RE.test(n),
    );
    if (!entries.length) return 0;

    const referenced = await this.referencedAttachmentFileRefs();
    const now = Date.now();
    let removed = 0;

    for (const name of entries) {
      if (referenced.has(name)) continue;
      try {
        const st = statSync(join(this.attachmentDir, name));
        if (!st.isFile() || now - st.mtimeMs < this.attachmentRetainMs)
          continue;
        await rm(join(this.attachmentDir, name), { force: true });
        removed++;
      } catch {
        /* 单个失败不影响整体 */
      }
    }
    return removed;
  }

  /** 所有被消息引用过的附件 fileRef（清扫要跳过它们） */
  private async referencedAttachmentFileRefs(): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<{ ref: string | null }[]>`
      SELECT DISTINCT elem->>'fileRef' AS "ref"
      FROM "Message", jsonb_array_elements("attachments"::jsonb) AS "elem"
      WHERE "attachments" IS NOT NULL
        AND jsonb_typeof("attachments"::jsonb) = 'array'`;
    return new Set(rows.map((r) => r.ref).filter((v): v is string => !!v));
  }

  /** 启动附件清扫定时器（unref，不拖住进程退出） */
  private startAttachmentSweeper(): void {
    const intervalMs = Number(
      process.env.ATTACHMENT_SWEEP_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
    );
    const timer = setInterval(() => {
      void this.sweepExpiredAttachments().catch((e: any) =>
        console.warn('🧹 附件清扫失败:', e?.message || e),
      );
    }, intervalMs);
    timer.unref();
  }

}
