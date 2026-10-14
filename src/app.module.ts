import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthGuard } from './auth/auth.guard.js';
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
    AuthModule,
    ChatModule,
    VectorModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // ✅ 全局登录守卫：除 @Public() 外所有接口都要带 Bearer token
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
