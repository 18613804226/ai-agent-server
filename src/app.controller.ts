import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';
import { Public } from './auth/public.decorator.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // ✅ 健康检查保持公开，方便探活/网关检测
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
