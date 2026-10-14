// src/auth/current-device.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// ✅ 从 req.device（AuthGuard 挂载）取当前登录设备
export const CurrentDevice = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ device?: unknown }>();
    return req.device;
  },
);
