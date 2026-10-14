// src/auth/auth.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

// ✅ 全局守卫：除 @Public() 外所有接口都要带 Authorization: Bearer <token>
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['authorization'] || '';
    const token = header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : '';

    const device = await this.authService.validateToken(token);
    if (!device) {
      throw new UnauthorizedException('未登录或登录已过期，请重新登录');
    }
    // 挂到 request 上，接口用 @CurrentDevice() 取出
    (req as unknown as { device: unknown }).device = device;
    return true;
  }
}
