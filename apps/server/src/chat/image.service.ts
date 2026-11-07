import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { join, resolve, sep } from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service.js';

ffmpeg.setFfmpegPath(ffmpegPath as string);

// ✅ 送给大模型的图片：长边压到 1280 再发。实测 2400x1600 的图 token 从 2516 降到 1095
//    （省 56%），而图里的文字内容模型照样读得出来。原始高清图仍留在 uploads 供前端展示。
const MODEL_IMAGE_MAX_EDGE = 1280;

// ✅ 图片解码后的大小上限：超过给用户看得懂的报错。
//    body 层有路由级 12mb 限宽兜底（见 main.ts），超大的 base64 在那里就被 413 挡掉，
//    但 8MB～9MB 这段「常见手机直拍」区间必须由这里给出友好提示，而不是裸 413。
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 图片上传、压缩、安全校验与孤儿清理。
 * 从 ChatService 抽出来，避免核心流水线文件继续膨胀。
 */
@Injectable()
export class ImageService {
  /**
   * uploads 里我们自己生成的图片文件名规则。
   * 删除接口与孤儿清扫都只认这个格式：能挡住 `../` 穿越、子目录、
   * 以及任何我们没生成过的文件（比如别人放进来的配置或密钥）。
   */
  private static readonly UPLOAD_IMG_RE =
    /^img-\d{10,}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|gif|webp|bmp|avif)$/i;

  constructor(private readonly prisma: PrismaService) {
    this.startUploadsSweeper();
  }

  // ✅ 接收前端发送的图片（data URL / base64），落盘后返回可访问的 URL，供大模型识别
  async uploadImage(image: string, host?: string): Promise<{ url: string }> {
    if (!image || !image.startsWith('data:')) {
      throw new BadRequestException('不是有效的 data URL 图片');
    }
    const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
    if (!match) {
      throw new BadRequestException('图片不是 base64 格式，无法解析');
    }
    const mime = match[1];
    const base64 = match[2];
    // 解码一次，校验大小和写盘共用
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new BadRequestException('图片过大，请压缩到 8MB 以内');
    }
    const ext = mime.replace('image/', '');

    const uploadDir = join(process.cwd(), 'uploads');
    // recursive: true 本身就会创建目录，不用先 existsSync 判断
    await mkdir(uploadDir, { recursive: true });
    const filename = `img-${Date.now()}-${randomUUID()}.${ext}`;
    const filepath = join(uploadDir, filename);
    // ✅ 异步写盘：同步写会把这段时间整个事件循环占死，所有 SSE 用户的流式输出一起卡顿
    await writeFile(filepath, buffer);

    const trimmedHost = host ? host.replace(/\/+$/, '') : '';
    const url = trimmedHost
      ? `${trimmedHost}/uploads/${filename}`
      : `/uploads/${filename}`;
    return { url };
  }

  // ✅ 本地 uploads 文件 → base64 data URL（直接读盘，无需 HTTP 自调）
  private mimeByExt(ext: string): string {
    const map: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      avif: 'image/avif',
    };
    return map[ext.toLowerCase()] || 'application/octet-stream';
  }

  // ✅ 解析 uploads 目录内的文件路径，解析后必须仍在该目录内（防 ../ 穿越读到任意文件）
  private resolveUploadsFilePath(pathname: string): string | null {
    const root = resolve(process.cwd(), 'uploads');
    let rel: string;
    try {
      rel = decodeURIComponent(
        pathname.replace(/^\/uploads\//, '').replace(/^\/+/, ''),
      );
    } catch {
      return null; // 非法百分号编码
    }
    if (!rel || rel.includes('\0')) return null;
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) return null;
    return target;
  }

  /** 文件名是否已被某条消息的 images 引用（引用过的不能删，否则历史回显坏掉） */
  private async isImageReferenced(filename: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM "Message"
      WHERE "images" IS NOT NULL
        AND ("images"::text) LIKE ${'%' + filename + '%'}
      LIMIT 1`;
    return rows.length > 0;
  }

  /**
   * 删除一张「预上传但最终没发出去」的图片。
   *
   * 安全设计：
   * 1. 文件名必须匹配 uploadImage 的生成规则，否则直接 400（挡穿越）
   * 2. 再走一次 resolveUploadsFilePath 兜底确认仍在 uploads 内
   * 3. 被消息引用过的文件返回 409 拒绝删 —— 宁可留孤儿也别把历史记录弄坏
   */
  async deleteUploadedImage(filename: string): Promise<void> {
    if (!ImageService.UPLOAD_IMG_RE.test(filename)) {
      throw new BadRequestException('非法文件名');
    }
    if (await this.isImageReferenced(filename)) {
      throw new HttpException(
        '该图片已被消息引用，不能删除',
        HttpStatus.CONFLICT,
      );
    }
    const filepath = this.resolveUploadsFilePath(filename);
    if (!filepath) {
      throw new BadRequestException('非法文件名');
    }
    try {
      await rm(filepath, { force: false });
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        throw new NotFoundException('文件不存在或已删除');
      }
      throw e;
    }
  }

  /** 所有被消息引用过的图片 basename（孤儿清扫要跳过它们） */
  private async referencedImageBasenames(): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT DISTINCT regexp_replace(elem, '^.*/', '') AS "name"
      FROM "Message", jsonb_array_elements_text("images"::jsonb) AS "elem"
      WHERE "images" IS NOT NULL`;
    return new Set(rows.map((r) => r.name));
  }

  /**
   * 定期清理 uploads 里的孤儿图片 —— 覆盖「选了没发、也没点 X」的场景。
   * 双保险条件：**没被任何消息引用** + **存留超过阈值**（默认 60 分钟，避免删到刚上传还在编辑的）。
   * 扫描本身很轻（只读文件名和 mtime），30 分钟一次，unref 不拖住进程退出。
   */
  private startUploadsSweeper(): void {
    if (process.env.UPLOADS_SWEEP_ENABLED === 'false') {
      console.log('🧹 uploads 孤儿清扫已禁用（UPLOADS_SWEEP_ENABLED=false）');
      return;
    }
    const intervalMs = Number(
      process.env.UPLOADS_SWEEP_INTERVAL_MS ?? 30 * 60 * 1000,
    );
    const timer = setInterval(() => {
      void this.sweepOrphanUploads().catch((e: any) =>
        console.warn('🧹 uploads 清扫失败:', e?.message || e),
      );
    }, intervalMs);
    // 别让定时器拖着进程不退出
    timer.unref();
    console.log(
      `🧹 uploads 孤儿清扫已启动：每 ${Math.round(intervalMs / 60000)} 分钟一次`,
    );
  }

  /** 执行一次清扫，返回删除的文件数（也供手动触发/测试） */
  async sweepOrphanUploads(): Promise<number> {
    const dir = resolve(process.cwd(), 'uploads');
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return 0; // 目录不存在
    }
    if (!entries.length) return 0;

    const referenced = await this.referencedImageBasenames();
    const minAgeMs =
      Number(process.env.UPLOADS_ORPHAN_MIN_AGE_MIN ?? 60) * 60 * 1000;
    const now = Date.now();
    let removed = 0;

    for (const name of entries) {
      // 只碰我们自己生成的文件，且没被消息引用
      if (!ImageService.UPLOAD_IMG_RE.test(name)) continue;
      if (referenced.has(name)) continue;
      try {
        const st = await stat(join(dir, name));
        if (!st.isFile() || now - st.mtimeMs < minAgeMs) continue;
        await rm(join(dir, name), { force: true });
        removed++;
      } catch {
        /* 单个文件失败不影响整体清扫 */
      }
    }
    if (removed) {
      console.log(`🧹 uploads 清扫：删除 ${removed} 个孤儿图片`);
    }
    return removed;
  }

  // ✅ 站外图片域名白名单：默认空 = 一律不放行，避免服务端被当跳板打内网（SSRF）
  //   需要拉取站外图片时配置 IMAGE_FETCH_ALLOWLIST=oss-cn-beijing.aliyuncs.com,example.com
  private isImageFetchAllowed(hostname: string): boolean {
    const allow = (process.env.IMAGE_FETCH_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return allow.includes(hostname.toLowerCase());
  }

  // ✅ 判断一个图片引用是「本站 uploads 本地文件」还是「白名单站外地址」
  //   返回 null = 不可信，调用方必须拒绝
  classifyImageRef(imageRef: string): {
    localPath?: string;
    remoteUrl?: string;
  } | null {
    if (imageRef.startsWith('data:')) return {};
    if (imageRef.startsWith('/uploads/')) {
      const localPath = this.resolveUploadsFilePath(imageRef);
      return localPath ? { localPath } : null;
    }
    if (!/^https?:\/\//i.test(imageRef)) return null;

    let u: URL;
    try {
      u = new URL(imageRef);
    } catch {
      return null; // 不是合法 URL
    }
    if (u.pathname.startsWith('/uploads/')) {
      const localPath = this.resolveUploadsFilePath(u.pathname);
      return localPath ? { localPath } : null;
    }
    return this.isImageFetchAllowed(u.hostname)
      ? { remoteUrl: imageRef }
      : null;
  }

  // ✅ 把图片缩到长边 MODEL_IMAGE_MAX_EDGE 再交给模型，并按内容 hash 缓存到磁盘。
  //    toDataURL 每轮对话都会调，不缓存的话同一张图要被反复压缩。
  private async buildModelSizedImage(
    raw: Buffer,
    srcExt: string,
  ): Promise<{ buf: Buffer; ext: string }> {
    // 源图是 png 就继续输出 png：jpeg 没有透明通道，带 alpha 的图会变成黑底
    const ext = srcExt === 'png' ? 'png' : 'jpg';
    const cacheDir = join(process.cwd(), 'uploads', '.model-cache');
    const key = createHash('sha1').update(raw).digest('hex');
    const outPath = join(cacheDir, `${key}.${ext}`);

    if (existsSync(outPath)) return { buf: await readFile(outPath), ext };

    await mkdir(cacheDir, { recursive: true });
    const srcPath = join(cacheDir, `${key}.src`);
    // 先写临时文件、成功后再改名：避免 ffmpeg 中途失败留下半截文件被缓存永久命中
    // 临时名必须保留真实扩展名，fluent-ffmpeg 靠它推断输出格式
    const tmpPath = join(
      cacheDir,
      `${key}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp.${ext}`,
    );
    try {
      await writeFile(srcPath, raw);
      await new Promise<void>((resolve, reject) => {
        const cmd = ffmpeg(srcPath).outputOptions([
          '-vf',
          `scale='min(${MODEL_IMAGE_MAX_EDGE},iw)':-2`,
        ]);
        if (ext === 'png') cmd.outputOptions(['-c:v', 'png']);
        else cmd.outputOptions(['-q:v', '3']);
        cmd
          .on('end', () => resolve())
          .on('error', reject)
          .save(tmpPath);
      });
      await rename(tmpPath, outPath);
      return { buf: await readFile(outPath), ext };
    } catch (err) {
      // 压不出来就退回原图，别让压缩失败把整个请求带崩
      console.warn('图片压缩失败，回退到原图:', (err as Error).message);
      return { buf: raw, ext: srcExt };
    } finally {
      await rm(srcPath, { force: true });
      await rm(tmpPath, { force: true });
    }
  }

  // ✅ 把图片 URL/路径统一转成 base64 data URL，保证大模型始终能读取到图片内容
  // （解决部署在 localhost/内网时，LLM 服务器无法访问本地 /uploads 地址的问题）
  async toDataURL(imageRef: string): Promise<string> {
    const classified = this.classifyImageRef(imageRef);
    if (!classified) {
      throw new BadRequestException(
        '图片来源不被信任：只允许本站已上传的图片（/uploads/），或 IMAGE_FETCH_ALLOWLIST 白名单内的地址',
      );
    }
    if (!classified.localPath && !classified.remoteUrl) return imageRef; // data: 本身

    let raw: Buffer;
    let srcExt: string;
    if (classified.localPath) {
      if (!existsSync(classified.localPath)) {
        throw new BadRequestException('图片不存在或已被清理');
      }
      raw = await readFile(classified.localPath);
      srcExt = (classified.localPath.split('.').pop() || '').toLowerCase();
    } else {
      const res = await axios.get(classified.remoteUrl!, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 10 * 1024 * 1024,
      });
      const mime = String(
        res.headers['content-type'] || 'application/octet-stream',
      );
      if (!mime.startsWith('image/')) {
        throw new BadRequestException(`远程地址不是图片：${mime}`);
      }
      raw = Buffer.from(res.data);
      srcExt = (mime.split('/')[1] || 'jpeg').split('+')[0];
    }

    // ✅ 压完再送：token 按分辨率计费，长边压到 1280 能省一半以上
    const small = await this.buildModelSizedImage(raw, srcExt);
    return `data:${this.mimeByExt(small.ext)};base64,${small.buf.toString('base64')}`;
  }
}
