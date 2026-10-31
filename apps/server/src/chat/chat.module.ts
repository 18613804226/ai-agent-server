import { Module } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { ChatController } from './chat.controller.js';
import { AttachmentService } from './attachment.service.js';
import { ExcelService } from './excel.service.js';
import { ImageService } from './image.service.js';
import { KnowledgeService } from './knowledge.service.js';
import { SessionService } from './session.service.js';
import { SpeechService } from './speech.service.js';
import { VectorModule } from '../vector/vector.module.js'; // 引入向量模块以调用 VectorService

@Module({
  imports: [VectorModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    SessionService,
    ImageService,
    AttachmentService,
    KnowledgeService,
    SpeechService,
    ExcelService,
  ],
})
export class ChatModule {}
