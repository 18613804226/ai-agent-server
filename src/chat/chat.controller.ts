import { Controller, Post, Get, Body, Param, Sse, Req } from '@nestjs/common'; // 💡 1. 引入 Req
import type { Request } from 'express'; // 💡 2. 引入 Express 的 Request 类型
import { ChatService } from './chat.service.js';
import { Observable, Subject } from 'rxjs';

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

  @Post(':id/stream')
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
