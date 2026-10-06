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
import { Observable, Subject } from 'rxjs';
import multer from 'multer';
import { FileInterceptor } from '@nestjs/platform-express';
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('session')
  async createSession(@Body('title') title?: string) {
    return this.chatService.createSession(title);
  }
  @Get('sessions')
  async getSessions() {
    return this.chatService.getSessions();
  }
  @Get('sessions/:id')
  async getSessionDetail(@Param('id') id: string) {
    return this.chatService.getSessionDetail(id);
  }
  @Put('sessions/:id')
  async updateSessionTitle(
    @Param('id') id: string,
    @Body('title') title: string,
  ) {
    return this.chatService.updateSessionTitle(id, title);
  }
  @Delete('sessions/:id')
  async deleteSession(@Param('id') id: string) {
    // 必须通过注入的 chatService 去调，不能直接用 this.prisma
    return this.chatService.deleteSession(id);
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

  // ---------------- 知识库 ----------------
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

  @Delete('knowledge/files/:id')
  @HttpCode(204)
  async deleteKnowledgeFile(@Param('id') id: string) {
    await this.chatService.deleteKnowledgeFile(id);
  }

  @Post(':id/stream')
  @HttpCode(200) // 💡 1. 强制让 POST 请求返回 200 OK
  @Sse()
  async streamMessage(
    @Param('id') sessionId: string,
    @Body() body: { query: string; images?: string[]; fileIds?: string[] },
    @Res({ passthrough: true }) res: Response,
  ): Promise<Observable<MessageEvent>> {
    const subject$ = new Subject<MessageEvent>();
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

    // 异步执行流式对话
    this.chatService
      .sendMessageStream(
        sessionId,
        body.query,
        (type, text) => {
          // 断开了就别再往已经关闭的响应里写
          if (!isClientDisconnected) {
            subject$.next({
              data: { type, content: text },
            } as MessageEvent);
          }
        },
        body.images, // 图片 URL 列表，交给大模型识别
        abortController.signal,
        body.fileIds, // 知识库文件 ID 列表，用于限定 RAG 检索范围
      )
      .then(() => {
        if (!isClientDisconnected) {
          subject$.complete();
        }
      })
      .catch((err) => {
        if (!isClientDisconnected) {
          subject$.error(err);
        }
      });
    return subject$.asObservable();
  }
}
