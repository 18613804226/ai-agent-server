import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ChatModule } from './chat/chat.module.js'; // 引入 ChatModule
import { VectorModule } from './vector/vector.module.js'; // 引入 VectorModule

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // 观测模块
    // ObserveModule.forRoot({
    //   appKey: 'YOUR_APP_KEY',
    //   appSecret: 'YOUR_APP_SECRET',
    //   serviceId: 'ai-agent-server',
    // }),
    // 🚀 在这里把你的业务模块加进来！
    ChatModule,
    VectorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
