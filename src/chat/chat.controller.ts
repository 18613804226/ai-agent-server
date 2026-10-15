import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Sse,
  Req,
  Res,
  Put,
  Delete,
  HttpCode,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common'; // 💡 1. 引入 Req
import type { Request, Response } from 'express'; // 💡 2. 引入 Express 的 Request 类型
import { ChatService } from './chat.service.js';
import { AuthService } from '../auth/auth.service.js';
import { CurrentDevice } from '../auth/current-device.decorator.js';
import { Observable } from 'rxjs';
import multer from 'multer';
import { FileInterceptor } from '@nestjs/platform-express';
@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly authService: AuthService,
  ) {}

  @Post('session')
  async createSession(
    @CurrentDevice() device: any,
    @Body('title') title?: string,
  ) {
    // ✅ 会话绑定当前登录设备
    return this.chatService.createSession(device?.id, title);
  }
  @Get('sessions')
  async getSessions(@CurrentDevice() device: any) {
    // ✅ 只返回本设备的会话
    return this.chatService.getSessions(device?.id);
  }
  @Get('sessions/:id')
  async getSessionDetail(
    @CurrentDevice() device: any,
    @Param('id') id: string,
  ) {
    return this.chatService.getSessionDetail(id, device?.id);
  }
  @Put('sessions/:id')
  async updateSessionTitle(
    @CurrentDevice() device: any,
    @Param('id') id: string,
    @Body('title') title: string,
  ) {
    return this.chatService.updateSessionTitle(id, title, device?.id);
  }
  @Delete('sessions/:id')
  async deleteSession(@CurrentDevice() device: any, @Param('id') id: string) {
    // 必须通过注入的 chatService 去调，不能直接用 this.prisma
    return this.chatService.deleteSession(id, device?.id);
  }

  @Post('tts')
  async tts(@Body() body: { text: string; voice?: string }) {
    const { text, voice } = body;
    return this.chatService.textToSpeech(text, voice);
  }

  @Post('upload-image')
  async uploadImage(@Body() body: { image: string }, @Req() req: Request) {
    if (!body?.image) throw new BadRequestException('没有收到图片数据');
    const host = `${req.protocol}://${req.get('host')}`;
    return this.chatService.uploadImage(body.image, host);
  }

  @Post('asr')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: 15 * 1024 * 1024 },
    }),
  )
  async speechToText(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('没有收到音频文件');
    return this.chatService.speechToText(file.buffer, file.mimetype);
  }

  // ---------------- 知识库（全局共享，登录即可用） ----------------
  @Post('knowledge/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
      // ✅ busboy 默认按 latin1 解析 multipart 头里的 filename，浏览器发的是 UTF-8 字节，
      //    中文文件名会变乱码。改为 utf8 从源头修正。
      defParamCharset: 'utf8',
    }),
  )
  async uploadKnowledgeFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('没有收到文件');
    return this.chatService.uploadKnowledgeFile(file);
  }

  @Get('knowledge/files')
  async getKnowledgeFiles() {
    return this.chatService.listKnowledgeFiles();
  }

  // ✅ 向量化进度（前端轮询）：返回 status / processedChunks / totalChunks / progress%
  @Get('knowledge/files/:id/progress')
  async getKnowledgeProgress(@Param('id') id: string) {
    return this.chatService.getKnowledgeFileProgress(id);
  }

  @Put('knowledge/files/:id/enabled')
  async setKnowledgeFileEnabled(
    @Param('id') id: string,
    @Body('enabled') enabled: unknown,
  ) {
    return this.chatService.setKnowledgeFileEnabled(id, enabled);
  }

  @Delete('knowledge/files/:id')
  @HttpCode(204)
  async deleteKnowledgeFile(@Param('id') id: string) {
    await this.chatService.deleteKnowledgeFile(id);
  }

  // ---------------- 聊天附件（一次性解析，不入知识库） ----------------
  @Post('attachment')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
      // busboy 默认按 latin1 解析 filename，中文名会乱码，与知识库上传保持一致
      defParamCharset: 'utf8',
    }),
  )
  async uploadAttachment(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('没有收到文件');
    return this.chatService.uploadChatAttachment(file);
  }

  // ---------------- Excel 错误识别（不落库、不向量化） ----------------
  @Post('excel/check')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
      defParamCharset: 'utf8',
    }),
  )
  async checkExcel(
    @UploadedFile() file: Express.Multer.File,
    @Body('rules') rules?: string,
  ) {
    return this.chatService.checkExcelFile(file, rules);
  }

  /**
   * 删除一张「预上传但没发出去」的图片。
   * 前端只在删图片 chip / 清空已选图片时调用；已被消息引用的图会被拒（409），
   * 历史回显不受影响。服务端另有定时清扫兜底未调用本接口的孤儿文件。
   */
  /**
   * 读取/预览一个聊天附件（带登录态）。
   * PDF、图片、文本、视频按白名单 content-type 内联返回，其余走下载。
   * 不走静态托管：附件可能含 doc/txt/代码，任意后缀直出有存储型 XSS 风险。
   */
  @Get('attachments/:fileRef')
  async getAttachment(
    @Param('fileRef') fileRef: string,
    @Res() res: Response,
  ) {
    const { path, contentType, fileName } =
      await this.chatService.getAttachmentFile(fileRef);
    const inlineTypes = ['application/pdf', 'image/', 'text/', 'video/'];
    const disposition = inlineTypes.some((t) => contentType.includes(t))
      ? 'inline'
      : 'attachment';
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${encodeURIComponent(fileName)}"`,
    );
    // 必须用 @Res()（非 passthrough）+ sendFile：passthrough 模式下 Nest 会把
    // createReadStream 的返回值 JSON 序列化，前端拿到的就是流对象而非文件内容。
    // acceptRanges 让视频可以拖进度条。
    res.sendFile(path, { acceptRanges: true, dotfiles: 'deny' });
  }

  /**
   * 删除一份「预上传附件」（POST /chat/attachment 后、消息还没发送时的清理）。
   * 已被消息引用的附件返回 409 拒绝，保护历史回显。
   */
  @Delete('attachments/:fileRef')
  @HttpCode(204)
  async deleteAttachment(@Param('fileRef') fileRef: string) {
    await this.chatService.deleteChatAttachment(fileRef);
  }

  @Delete('uploads/:filename')
  @HttpCode(204)
  async deleteUpload(@Param('filename') filename: string) {
    await this.chatService.deleteUploadedImage(filename);
  }

  @Post(':id/stream')
  @HttpCode(200) // 💡 1. 强制让 POST 请求返回 200 OK
  @Sse()
  @UseInterceptors(
    // ✅ 支持「文件/视频随消息一起发」：同一个请求里既带文件又带 query。
    //    JSON 请求不会走 multer（没有 file），行为与老版本完全一致。
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
      defParamCharset: 'utf8',
    }),
  )
  async streamMessage(
    @CurrentDevice() device: any,
    @Param('id') sessionId: string,
    @Body()
    body: {
      query?: string;
      images?: unknown;
      fileIds?: unknown;
      attachmentIds?: unknown;
    },
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Observable<MessageEvent>> {
    // ✅ 发言前校验每日配额（超限抛 429，不计费）
    await this.authService.assertQuota(device);

    // multipart 里的数组字段是 JSON 字符串，JSON 请求里是原生数组，这里统一成 string[]
    const asList = (v: unknown): string[] | undefined => {
      if (v === undefined || v === null || v === '') return undefined;
      if (Array.isArray(v)) return v as string[];
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? parsed : [String(parsed)];
        } catch {
          // 也兼容 "a,b,c" 这种逗号分隔写法
          return v.split(',').map((s) => s.trim()).filter(Boolean);
        }
      }
      return undefined;
    };

    const query = typeof body?.query === 'string' ? body.query : '';
    if (!query.trim() && !file) {
      throw new BadRequestException('query 和文件至少要提供一样');
    }
    // ✅ 类型/大小这类「一眼能看出」的错误，在建立 SSE 之前就以 400 返回，
    //    不必等连接建好再用 SSE error 事件告诉前端
    if (file) this.chatService.validateChatAttachment(file);

    let isClientDisconnected = false;
    // ✅ 客户端一断开就 abort 掉上游大模型请求，否则模型还会继续生成，白烧 token
    const abortController = new AbortController();

    // ⚠️ 不能用 req.on('close')：Node 16 起它是「请求体读完」就触发（实测 +4ms），
    //    跟客户端断不断开毫无关系。必须监听 res，且用 writableFinished 区分正常结束。
    res.on('close', () => {
      if (!res.writableFinished) {
        isClientDisconnected = true;
        abortController.abort();
      }
    });

    // ⚠️ 必须用 Observable 的 subscribe 函数而不是 Subject：Subject 是热流，
    //    在 handler 返回、Nest 建立订阅之前发出的第一个事件会被直接丢掉
    //    （实测「正在解析附件」提示就是这么丢的）。Observable 在被订阅后才开始工作。
    return new Observable<MessageEvent>((subscriber) => {
      void (async () => {
        try {
          let inlineAttachments:
            | Array<{
                id: string;
                fileRef: string;
                url: string;
                name: string;
                kind: 'document' | 'video';
                text: string;
                charCount: number;
                durationSec?: number;
              }>
            | undefined;

          if (file) {
            // 视频转写可能要几十秒，先推一条提示，避免连接静默挂起
            subscriber.next({
              data: {
                type: 'thought',
                content: `正在解析附件 ${file.originalname}…（视频需转写，可能稍久）`,
              },
            } as MessageEvent);
            const parsed = await this.chatService.parseChatAttachment(file);
            // 缓存进内存：同一会话内紧接着追问不用重新解析
            this.chatService.rememberChatAttachment(parsed);
            inlineAttachments = [parsed];
          }

          const result = await this.chatService.sendMessageStream(
            sessionId,
            query,
            (type, content) => {
              // 断开了就别再往已经关闭的响应里写
              if (!isClientDisconnected) {
                subscriber.next({
                  data:
                    type === 'sources'
                      ? { type, sources: content }
                      : { type, content },
                } as MessageEvent);
              }
            },
            asList(body?.images), // 图片 URL 列表，交给大模型识别
            abortController.signal,
            asList(body?.fileIds), // 知识库文件 ID 列表，用于限定 RAG 检索范围
            asList(body?.attachmentIds), // 先上传后引用的附件 ID
            inlineAttachments, // 随本条消息直传的附件（已当场解析）
          );

          if (!isClientDisconnected) {
            // ✅ 完成后记账：次数 +1、token 累加（客户端断开不重复计）
            void this.authService.recordUsage(device.id, result?.tokens ?? 0);
            subscriber.complete();
          }
        } catch (err) {
          if (!isClientDisconnected) {
            subscriber.error(err);
          }
        }
      })();

      // 退订（客户端断开）时中断上游
      return () => {
        isClientDisconnected = true;
        abortController.abort();
      };
    });
  }
}
