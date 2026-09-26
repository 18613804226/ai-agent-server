import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Sse,
  Req,
  Put,
  Delete,
  HttpCode,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common'; // 💡 1. 引入 Req
import type { Request } from 'express'; // 💡 2. 引入 Express 的 Request 类型
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

  @Post(':id/stream')
  @HttpCode(200) // 💡 1. 强制让 POST 请求返回 200 OK
  @Sse()
  async streamMessage(
    @Param('id') sessionId: string,
    @Body() body: { query: string },
    @Req() req: Request, // 💡 3. 注入当前的 HTTP 请求对象
  ): Promise<Observable<MessageEvent>> {
    const subject$ = new Subject<MessageEvent>();
    let isClientDisconnected = false;

    // 💡 4. 监听前端是否断开连接（比如点击了停止按钮、关闭了页面或切换了会话）
    req.on('close', () => {
      isClientDisconnected = true;
    });

    // 异步执行流式对话，传入中断检查回调
    this.chatService
      .sendMessageStream(
        sessionId,
        body.query,
        (type, text) => {
          // 💡 1. 接收两个参数：type ('thought' | 'content') 和 文本内容
          // 如果没断开，才推送数据
          if (!isClientDisconnected) {
            // 💡 2. 将 type 和 content 一起打包进 data 中发送给前端
            subject$.next({
              data: {
                type: type, // 把类型带上（'thought' 或 'content'）
                content: text, // 文本增量
              },
            } as MessageEvent);
          }
        },
        () => isClientDisconnected, // 状态检查函数
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
