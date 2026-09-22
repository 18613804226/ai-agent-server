// src/prisma/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // 1. 创建 pg 连接池
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    // 2. 实例化 Prisma pg 适配器
    const adapter = new PrismaPg(pool);

    // 3. 传递给父类 PrismaClient
    super({ adapter });
  }

  // NestJS 启动时连接数据库
  async onModuleInit() {
    await this.$connect();
  }

  // NestJS 关闭时断开连接
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
