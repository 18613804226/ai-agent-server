import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import OpenAI from 'openai';
import axios from 'axios';
import * as https from 'https';
import WebSocket from 'ws';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { existsSync } from 'fs';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { evaluate } from 'mathjs';
import {
  finalizeToolCalls,
  mergeToolCallDeltas,
  type ToolCallAccumulator,
} from './tool-call-accumulator.js';
// ✅ 模块顶层：整个进程只建一次，所有 TTS 请求复用这套连接
const dashscopeAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60_000,
  maxSockets: 10,
});

const ttsClient = axios.create({
  timeout: 60_000,
  httpsAgent: dashscopeAgent,
});

ffmpeg.setFfmpegPath(ffmpegPath as string);

// ASR WebSocket 地址：默认全局域名；401/403 时换成业务空间专属：
// wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
const ASR_WS_URL =
  process.env.DASHSCOPE_WS_URL ||
  'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

// ✅ 送给大模型的图片：长边压到 1280 再发。实测 2400x1600 的图 token 从 2516 降到 1095
//    （省 56%），而图里的文字内容模型照样读得出来。原始高清图仍留在 uploads 供前端展示。
const MODEL_IMAGE_MAX_EDGE = 1280;
// ✅ 一次最多 2 张图进模型上下文（当前轮优先，剩余名额从最新历史消息补）
const MAX_MODEL_IMAGES = 2;
// ✅ 单图预算（压缩后长边上限 1280 时实测 1095 token），取整留余量做保守估算
const MODEL_IMAGE_TOKEN_COST = 1200;

// ✅ 粗略 token 估算：CJK 每字 ~1 token，英文每 3.5 字符 ~1 token
const estimateTokens = (text: string): number => {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
};
@Injectable()
export class ChatService {
  private openai: OpenAI;
  private readonly model: string;
  private tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'fetchWeatherInfo',
        description:
          '当用户明确询问某个城市或地区的实时天气、气温情况时调用。只在问天气时用。',
        parameters: {
          type: 'object',
          properties: {
            cityName: {
              type: 'string',
              description: '城市名称，如：北京、广州',
            },
          },
          required: ['cityName'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'calculator',
        description:
          '数学计算器。只要问题涉及任何数值计算（加减乘除、百分比、折扣、日期差、单位换算等）必须使用，禁止心算。',
        parameters: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: '数学表达式，如 (100+20)*0.85、 365*24 ',
            },
          },
          required: ['expression'],
        },
      },
    },
  ];

  // ✅ 工具执行器：名字 → 实现
  private async execTool(name: string, args: any): Promise<string> {
    if (name === 'fetchWeatherInfo') {
      return this.fetchWeatherInfoByCity(args.cityName || '广州');
    }
    if (name === 'calculator') {
      try {
        const result = evaluate(String(args.expression || ''));
        return `计算结果：${args.expression} = ${result}`;
      } catch (e: any) {
        return `表达式无法计算：${e.message}。请提醒用户检查算式。`;
      }
    }
    return `未知工具：${name}`;
  }

  constructor(
    private prisma: PrismaService,
    private vectorService: VectorService,
  ) {
    this.model =
      process.env.CHAT_MODEL || process.env.OPENAI_MODEL || 'qwen3.8-flash';
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || '',
      baseURL: process.env.OPENAI_BASE_URL || '',
    });
  }

  // 创建新对话会话
  async createSession(title?: string) {
    const MAX_SESSIONS = 20;
    const existingSessions = await this.prisma.chatSession.findMany({
      orderBy: { createdAt: 'asc' },
    });
    if (existingSessions.length >= MAX_SESSIONS) {
      const oldestSession = existingSessions[0];
      await this.prisma.chatSession.delete({
        where: { id: oldestSession.id },
      });
    }
    return this.prisma.chatSession.create({
      data: { title: title || '' },
    });
  }

  async updateSessionTitle(id: string, title: string) {
    return this.prisma.chatSession.update({ where: { id }, data: { title } });
  }

  async deleteSession(id: string) {
    return this.prisma.chatSession.delete({ where: { id } });
  }

  async getSessions() {
    return this.prisma.chatSession.findMany({
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getSessionDetail(id: string) {
    return this.prisma.chatSession.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
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
    const ext = mime.replace('image/', '');

    const uploadDir = join(process.cwd(), 'uploads');
    // recursive: true 本身就会创建目录，不用先 existsSync 判断
    await mkdir(uploadDir, { recursive: true });
    const filename = `img-${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const filepath = join(uploadDir, filename);
    // ✅ 异步写盘：同步写会把这段时间整个事件循环占死，所有 SSE 用户的流式输出一起卡顿
    await writeFile(filepath, Buffer.from(base64, 'base64'));

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
  private classifyImageRef(imageRef: string): {
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
    return this.isImageFetchAllowed(u.hostname) ? { remoteUrl: imageRef } : null;
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
        cmd.on('end', () => resolve()).on('error', reject).save(tmpPath);
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
  private async toDataURL(imageRef: string): Promise<string> {
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

  // 辅助函数：根据城市名获取天气
  private async fetchWeatherInfoByCity(cityName: string): Promise<string> {
    try {
      const encodedCity = encodeURIComponent(cityName);
      const res = await axios.get(`https://wttr.in/${encodedCity}?format=j1`, {
        timeout: 4000,
      });
      const current = res.data.current_condition[0];
      const tempC = current.temp_C;
      const desc = current.weatherDesc[0].value;
      const humidity = current.humidity;
      return `【实时天气播报 - ${cityName}】：当前气温 ${tempC}℃，天气状况：${desc}，湿度：${humidity}%。`;
    } catch (error) {
      console.error('获取天气接口失败:', error);
      return `【实时天气播报】：暂时无法获取 ${cityName} 的实时天气数据。`;
    }
  }

  //  核心：支持 Function Calling 与流式（Streaming）输出的对话方法
  //  signal：客户端断开时 abort，会立刻掐断上游大模型请求（否则模型还在烧 token）
  async sendMessageStream(
    sessionId: string,
    userQuery: string,
    onChunk: (type: 'thought' | 'content' | 'error', text: string) => void,
    images?: string[],
    signal?: AbortSignal,
  ) {
    const overallStartTime = Date.now();
    const aborted = () => signal?.aborted === true;
    try {
      if (aborted()) return;

      // ✅ 先校验图片来源：不可信就直接失败，别把注定发不出去的消息写进库
      const hasImages = Array.isArray(images) && images.length > 0;
      if (hasImages) {
        for (const ref of images!) {
          if (!this.classifyImageRef(ref)) {
            throw new BadRequestException(
              '图片来源不被信任：只允许本站已上传的图片（/uploads/），或 IMAGE_FETCH_ALLOWLIST 白名单内的地址',
            );
          }
        }
      }

      // ✅ 闲聊不查 RAG，省掉一次 embedding 调用 + 向量检索
      const isCasualChat = /你的名字|你是谁|你好|在干嘛|hi|hello/.test(
        userQuery,
      );

      const parallelStartTime = Date.now();
      const [, relevantDocs, historyMessages] = await Promise.all([
        this.prisma.message.create({
          data: {
            sessionId,
            role: 'user',
            content: userQuery,
            // ✅ 图片 URL 一起落库，历史会话才能还原出图
            images: hasImages ? images : undefined,
          },
        }),
        isCasualChat
          ? Promise.resolve([] as any[])
          : this.vectorService.searchSimilar(userQuery, 3),
        this.prisma.message.findMany({
          where: { sessionId },
          // ✅ 取最近 30 条（原来 asc 取的是最旧 30 条，长会话下最近上下文全丢）
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
      ]);
      const parallelDuration = Date.now() - parallelStartTime;
      console.log(
        `⏱️ [性能监控] 数据库写入 + 向量库检索(${relevantDocs.length}条) + 历史消息查询，总耗时: ${parallelDuration}ms`,
      );

      if (aborted()) return;

      const session = await this.prisma.chatSession.findUnique({
        where: { id: sessionId },
      });
      if (!session) {
        throw new NotFoundException(`ChatSession not found: ${sessionId}`);
      }

      // ✅ 反转回时间正序，再从最旧一条开始装上下文
      historyMessages.reverse();

      const MAX_CONTEXT_TOKENS = 1500; // RAG 资料上限，按需要调

      let context = isCasualChat
        ? ''
        : (relevantDocs as any[])
            .map((doc: any) => doc.content)
            .join('\n---\n');

      if (estimateTokens(context) > MAX_CONTEXT_TOKENS) {
        // 超了就从后往前丢文档，保住预算
        const docs = (relevantDocs as any[]).map((d: any) => d.content);
        while (
          docs.length > 1 &&
          estimateTokens(docs.join('\n---\n')) > MAX_CONTEXT_TOKENS
        ) {
          docs.pop();
        }
        context = docs.join('\n---\n');
      }

      const systemPrompt = `你是一个专属的 AI 智能助手。
    - 你的名字叫toto。
    - 当前时间：${new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(
      new Date(),
    )}。涉及"今天/明天/现在/星期几"的问题必须以这个时间为准，禁止自己推测日期。
    - 你是由开发者独立打造的智能助手，能够协助处理各种问题。

    【工具调用规则】：
    1. 只有当用户**明确询问某个城市的天气、气温或空气质量**时，才允许调用 \`fetchWeatherInfo\` 工具。
    2. 如果用户是在进行普通闲聊、询问你的身份、或者讨论技术问题，**严禁调用任何工具**，必须直接进行文字回复！
     
    【参考资料】：
    ${context}`;

      // ✅ 分配图片名额：当前轮优先，剩余名额从最新的历史消息往前补。
      //   这样「刚才那张红图再帮我看看」能接上，又不会让 token 随对话轮数无限膨胀。
      const currentRefs = (hasImages ? images! : []).slice(0, MAX_MODEL_IMAGES);
      const slotsForHistory = Math.max(0, MAX_MODEL_IMAGES - currentRefs.length);
      const historyImageRefs: string[] = [];
      for (let i = historyMessages.length - 1; i >= 0; i--) {
        if (historyImageRefs.length >= slotsForHistory) break;
        const prev = historyMessages[i].images;
        if (!Array.isArray(prev)) continue;
        for (const ref of prev) {
          if (historyImageRefs.length >= slotsForHistory) break;
          if (typeof ref === 'string' && !currentRefs.includes(ref)) {
            historyImageRefs.push(ref);
          }
        }
      }
      // 历史图可能已被清理或来源变不可信，单张失败就跳过，不影响整轮
      const historyImageUrls = new Map<string, string>();
      await Promise.all(
        historyImageRefs.map(async (ref) => {
          try {
            historyImageUrls.set(ref, await this.toDataURL(ref));
          } catch {
            /* 跳过这张 */
          }
        }),
      );

      const imageParts = (urls: string[]) =>
        urls.map((dataUrl) => ({
          type: 'image_url',
          image_url: { url: dataUrl },
        }));

      const MAX_INPUT_TOKENS = 6000;
      const systemTokens = estimateTokens(systemPrompt);
      const queryTokens = estimateTokens(userQuery);
      const currentImageUrls = await Promise.all(
        currentRefs.map((ref) => this.toDataURL(ref)),
      );
      // ✅ 当前轮的图在这里扣；历史图的费用由下面的装配循环按条扣，避免重复计费
      const imageTokens = currentImageUrls.length * MODEL_IMAGE_TOKEN_COST;
      let budget = MAX_INPUT_TOKENS - systemTokens - queryTokens - imageTokens;

      const formattedMessages = historyMessages.map((msg) => {
        const role = ['user', 'assistant', 'system', 'tool'].includes(msg.role)
          ? (msg.role as 'user' | 'assistant' | 'system' | 'tool')
          : 'user';
        // ✅ 历史里带图且抢到名额的消息，还原成多模态，让模型记得之前看过的图
        if (role === 'user' && Array.isArray(msg.images)) {
          const urls = (msg.images as string[])
            .filter((ref) => historyImageUrls.has(ref))
            .map((ref) => historyImageUrls.get(ref)!);
          if (urls.length) {
            return {
              role,
              content: [
                { type: 'text', text: msg.content },
                ...imageParts(urls),
              ],
            } as any;
          }
        }
        return { role, content: msg.content } as any;
      });
      // 从最新一条往前装，装不下就停（旧消息直接丢）
      const keptMessages: any[] = [];
      for (let i = formattedMessages.length - 1; i >= 0; i--) {
        const msg = formattedMessages[i];
        const parts = Array.isArray(msg.content) ? msg.content : null;
        const imageCount = parts
          ? parts.filter((p: any) => p.type === 'image_url').length
          : 0;
        const text = parts
          ? parts
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('')
          : String(msg.content ?? '');
        // ✅ 图片也要算钱，否则 estimateTokens 返回 0，预算永远扣不动
        const t = estimateTokens(text) + imageCount * MODEL_IMAGE_TOKEN_COST;
        if (budget - t < 0) break;
        budget -= t;
        keptMessages.unshift(msg);
      }

      // ✅ 构造多模态用户消息：文本 + 图片（image_url），这样大模型可以识别图片内容
      //   图片 URL 先统一转成 base64 data URL，保证本地/内网部署也能被大模型读取
      const userMessage: any = currentImageUrls.length
        ? {
            role: 'user',
            content: [
              { type: 'text', text: userQuery },
              ...imageParts(currentImageUrls),
            ],
          }
        : { role: 'user', content: userQuery };

      // ✅ 保证 keptMessages 末尾是当前用户问题（带图的多模态版本）
      //   历史查询与上面的写入是并发的，可能已经把这条读进来了 → 原地替换而不是追加，避免重复发两条
      const lastKept = keptMessages[keptMessages.length - 1];
      const isCurrentUserMsg =
        lastKept?.role === 'user' && lastKept.content === userQuery;
      if (isCurrentUserMsg) {
        keptMessages[keptMessages.length - 1] = userMessage;
      } else {
        keptMessages.push(userMessage);
      }

      if (aborted()) return;

      // ✅ 日志加在这里
      console.log(
        `🧮 [Token] system=${systemTokens}, query=${queryTokens}, 历史保留 ${keptMessages.length} 条, 剩余预算=${budget}`,
      );

      // ✅ 单轮流式 + 工具循环
      // 原来先跑一次「非流式决策轮」只为判断要不要调工具，产出 100% 被丢弃，
      // 实测平均白白多等 10s（最差 43s）。现在第一次请求就直接流式出字。
      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        ...keptMessages,
      ];

      const MAX_TOOL_ROUNDS = 4;
      let rawFullReply = '';
      let firstTurnTtft: number | null = null;

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        if (aborted()) return;

        const streamStartTime = Date.now();
        const toolAcc: ToolCallAccumulator = {};
        let roundReply = '';
        let roundTtft: number | null = null;

        const stream: any = await this.openai.chat.completions.create(
          {
            model: this.model,
            messages,
            stream: true,
            // 工具通过流式 delta 下发；enable_search 与 tools、stream 三者同时开已验证可用
            tools: this.tools,
            tool_choice: 'auto',
            enable_search: true,
            stream_options: { include_usage: true },
          } as any,
          // ✅ 客户端断开时立刻销毁到模型端的连接，不用等这一轮生成完
          { signal },
        );

        for await (const chunk of stream) {
          if (aborted()) {
            console.log('检测到用户中断，强行跳出大模型流生成。');
            break;
          }

          if (roundTtft === null) roundTtft = Date.now() - streamStartTime;
          if (firstTurnTtft === null) firstTurnTtft = roundTtft;

          const delta =
            (chunk as any).choices?.[0]?.delta || (chunk as any).message || {};

          if (delta.tool_calls?.length) {
            mergeToolCallDeltas(toolAcc, delta.tool_calls);
          }

          const reasoningContent =
            delta.reasoning_content ||
            delta.reasoning ||
            delta.thought ||
            (chunk as any).reasoning_content ||
            (chunk as any).thought ||
            (chunk as any).reasoning ||
            '';

          const textContent =
            delta.content ||
            delta.text ||
            delta.message ||
            (chunk as any).content ||
            (chunk as any).text ||
            (typeof chunk === 'string' ? chunk : '');

          if (!textContent && !reasoningContent) continue;

          if (reasoningContent) onChunk('thought', reasoningContent);

          if (textContent) {
            roundReply += textContent;
            rawFullReply += textContent;
            onChunk('content', textContent);
          }
        }

        const toolCalls = finalizeToolCalls(toolAcc);
        console.log(
          `⏱️ [性能监控] 第 ${round + 1} 轮流式耗时: ${Date.now() - streamStartTime}ms` +
            `，本轮首字 ${roundTtft ?? '-'}ms` +
            `，工具调用 ${toolCalls.length} 个`,
        );

        // ✅ 没有工具要调 → 这一轮就是最终回答
        if (!toolCalls.length) break;
        if (aborted()) return;

        // 有工具要调：把 assistant(tool_calls) 与执行结果追加进上下文，再来一轮流式
        messages.push({
          role: 'assistant',
          content: roundReply || null,
          tool_calls: toolCalls,
        });
        for (const call of toolCalls) {
          if (aborted()) return;
          let result: string;
          try {
            result = await this.execTool(
              call.function.name,
              JSON.parse(call.function.arguments || '{}'),
            );
          } catch (e: any) {
            result = `工具执行出错：${e.message}`;
          }
          messages.push({
            tool_call_id: call.id,
            role: 'tool',
            name: call.function.name,
            content: result,
          });
        }
      }

      const finalCleanReply = rawFullReply
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<\/?think>/g, '')
        .replace(/<\/?tool_call>/g, '')
        .trimStart();

      if (finalCleanReply) {
        await this.prisma.message.create({
          data: { sessionId, role: 'assistant', content: finalCleanReply },
        });
      }

      await this.prisma.chatSession.update({
        where: { id: sessionId },
        data: { updatedAt: new Date() },
      });

      const totalDuration = Date.now() - overallStartTime;
      console.log(
        `🚀 [性能监控] 请求完整生命周期总耗时: ${totalDuration}ms` +
          `，首字 ${firstTurnTtft ?? '-'}ms\n-----------------------------------------`,
      );

      return { fullReply: finalCleanReply, sources: relevantDocs };
    } catch (error: any) {
      const totalDuration = Date.now() - overallStartTime;

      // ✅ 客户端主动断开不是错误：上游请求被 abort 会抛 APIUserAbortError，
      //    这里安静收尾即可，别给前端推 error 事件（连接已经没了，推了也没人收）
      if (aborted() || error?.name === 'AbortError' || error?.name === 'APIUserAbortError') {
        console.log(
          `⏹️ [性能监控] 客户端已断开，提前结束（累计 ${totalDuration}ms）`,
        );
        return { fullReply: '', sources: [] };
      }

      console.error('sendMessageStream 执行出错:', error);
      console.log(`❌ [性能监控] 请求异常中断，累计耗时: ${totalDuration}ms`);

      const errorMsg =
        error.message || '服务器开小差了，请检查后端配置或账户余额';
      try {
        onChunk('error', errorMsg);
      } catch {}

      throw error;
    }
  }

  // -----------
  async textToSpeech(text: string, voice = 'Nini') {
    if (!text?.trim() || !/[\p{Script=Han}A-Za-z0-9]/u.test(text)) {
      throw new HttpException('文本内容无法朗读', HttpStatus.BAD_REQUEST);
    }

    const apiKey = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new HttpException(
        '未配置 DASHSCOPE_API_KEY 或 OPENAI_API_KEY',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const t0 = Date.now();
    const { data } = await ttsClient.post(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      {
        model: 'qwen3-tts-instruct-flash',
        input: {
          text: text.slice(0, 300),
          voice, // ⚠️ 音色名要换成 Qwen3 系列的（如 Cherry、Ethan），CosyVoice 的音色名不通用
        },
        parameters: {
          instructions: '语速比正常稍快一点，约1.2倍速，语气自然', // Instruct 版用自然语言控制语速，代替原来的 speech_rate
        },
      },
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    // 返回结构也不同：音频在 data.output.audio.url（或 content），不再是原来的字段，取数据的地方要跟着改
    console.log('🔊 TTS 首字节延迟:', Date.now() - t0, 'ms');

    const audioUrl =
      data?.output?.audio?.url ||
      data?.output?.audio_url ||
      data?.output?.url ||
      data?.audio_url ||
      data?.url;

    if (!audioUrl) {
      throw new HttpException(
        'TTS 未返回音频地址: ' + JSON.stringify(data).slice(0, 200),
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return { url: audioUrl };
  }

  // ✅ 非 wav 音频统一转码成 16k 单声道 pcm wav（ASR 的要求）
  private async toWav(inputPath: string): Promise<string> {
    const out = `${inputPath}.wav`;
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .audioChannels(1)
        .audioFrequency(16000)
        .audioCodec('pcm_s16le')
        .format('wav')
        .save(out)
        .on('end', () => resolve())
        .on('error', reject);
    });
    return out;
  }

  // ✅ 通过 WebSocket 调 qwen-audio-3.1-asr-flash-message（直连 DashScope，无需公网 URL）
  private async asrByWs(wavPath: string): Promise<string> {
    // ✅ 音频提前异步读一次（内容不会变），避免在 ws 消息回调里做同步 IO 卡住事件循环
    const audio = await readFile(wavPath);
    return new Promise((resolve, reject) => {
      const apiKey =
        process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY || '';
      const taskId = [...Array(32)]
        .map(() => Math.floor(Math.random() * 16).toString(16))
        .join('');
      const ws = new WebSocket(ASR_WS_URL, {
        headers: { Authorization: `bearer ${apiKey}` },
      });
      let text = '';
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const timer = setTimeout(() => {
        ws.terminate();
        done(() => reject(new Error('ASR 超时')));
      }, 30000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            header: {
              action: 'run-task',
              task_id: taskId,
              streaming: 'duplex',
            },
            payload: {
              task_group: 'audio',
              task: 'asr',
              function: 'recognition',
              model: 'qwen-audio-3.1-asr-flash-message',
              parameters: { format: 'wav', sample_rate: 16000 },
              input: {},
            },
          }),
        );
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return; // 非 JSON 帧（音频回包等），忽略
        }
        const event = msg.header?.event;
        if (event === 'task-started') {
          for (let i = 0; i < audio.length; i += 32768) {
            ws.send(audio.subarray(i, i + 32768));
          }
          ws.send(
            JSON.stringify({
              header: {
                action: 'finish-task',
                task_id: taskId,
                streaming: 'duplex',
              },
              payload: { input: {} },
            }),
          );
        } else if (event === 'result-generated') {
          text += msg.payload?.output?.sentence?.text ?? '';
        } else if (event === 'task-finished') {
          clearTimeout(timer);
          ws.close();
          done(() => resolve(text));
        } else if (event === 'task-failed') {
          clearTimeout(timer);
          ws.close();
          done(() =>
            reject(new Error(msg.header?.error_message || 'ASR 失败')),
          );
        }
      });

      ws.on('error', (err: any) => {
        clearTimeout(timer);
        done(() => reject(err));
      });
    });
  }

  // chat.service.ts
  async speechToText(audioBuffer: Buffer, mimeType: string) {
    const apiKey = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new HttpException(
        '未配置 API Key',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const tmpIn = join(tmpdir(), `asr-${Date.now()}`);
    const t0 = Date.now();
    try {
      await writeFile(tmpIn, audioBuffer);
      const isWav =
        mimeType.includes('wav') ||
        mimeType.includes('pcm') ||
        mimeType.includes('x-wav');
      const wavPath = isWav ? tmpIn : await this.toWav(tmpIn);

      const text = (await this.asrByWs(wavPath)).trim();
      console.log('🎙️ ASR 耗时:', Date.now() - t0, 'ms');

      if (!text) {
        throw new HttpException(
          '识别结果为空',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return { text };
    } finally {
      // force: true 文件不存在也不报错，不用先 existsSync 再 unlinkSync
      await Promise.all(
        [tmpIn, `${tmpIn}.wav`].map((f) => rm(f, { force: true })),
      );
    }
  }
}
