// src/prisma/prisma.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

@Global() // 加上 @Global() 装饰器后，全项目都可以直接注入 PrismaService，无需在每个 module 里重复 imports
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
