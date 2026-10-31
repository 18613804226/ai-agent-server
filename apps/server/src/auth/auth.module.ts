// src/auth/auth.module.ts
import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { AdminController } from './admin.controller.js';
import { AuthGuard } from './auth.guard.js';

@Global() // AuthGuard 需要全局生效：所有接口默认要登录
@Module({
  controllers: [AuthController, AdminController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService],
})
export class AuthModule {}
