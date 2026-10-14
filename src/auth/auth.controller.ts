// src/auth/auth.controller.ts
import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { CurrentDevice } from './current-device.decorator.js';
import { Public } from './public.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ✅ 查询当前登录设备（只读：不签发 token、不写库、无副作用）
  //    故意不加 @Public() → 走全局 AuthGuard，token 无效直接 401
  @Get('me')
  async me(@CurrentDevice() device: any) {
    return this.authService.getMyDevice(device);
  }

  // ✅ 普通用户登录：App 启动拿设备 ID 换取 token（首次自动注册）
  //    platform/model/osVersion 为前端上报的终端形态（可选），用于管理后台识别设备
  @Public()
  @Post('device-login')
  async deviceLogin(
    @Body()
    body: {
      deviceId?: string;
      platform?: string;
      model?: string;
      osVersion?: string;
    },
  ) {
    return this.authService.deviceLogin(body?.deviceId ?? '', body);
  }

  // ✅ 管理员登录：密码校验后下发管理员 token
  //    deviceId 可选，前端切换 admin 时带上当前设备 ID 即可把该设备升级为 admin
  @Public()
  @Post('admin-login')
  async adminLogin(
    @Body()
    body: {
      deviceId?: string;
      password?: string;
      platform?: string;
      model?: string;
      osVersion?: string;
    },
  ) {
    return this.authService.adminLogin(
      body.password || '',
      body.deviceId,
      body,
    );
  }

  // ✅ 游客/无设备 ID 时的兜底入口，等价于 device-login 的简写
  @Public()
  @Post('anonymous-login')
  async anonymousLogin(
    @Body()
    body: {
      deviceId?: string;
      platform?: string;
      model?: string;
      osVersion?: string;
    },
  ) {
    return this.authService.deviceLogin(body?.deviceId ?? '', body);
  }
}
