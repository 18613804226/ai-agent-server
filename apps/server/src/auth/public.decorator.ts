// src/auth/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
// ✅ 标记接口为公开：跳过 AuthGuard（登录注册类接口用）
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
