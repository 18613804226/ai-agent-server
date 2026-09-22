import { Module } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { ChatController } from './chat.controller.js';
import { VectorModule } from '../vector/vector.module.js'; // 引入向量模块以调用 VectorService

@Module({
  imports: [VectorModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
