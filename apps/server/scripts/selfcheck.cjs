#!/usr/bin/env node
/**
 * 构建期自检：确认生产镜像里关键依赖和 Prisma client 真的可用。
 *
 * 为什么需要它：
 * - Dockerfile 会先 `pnpm prune --prod` 砍掉 devDependencies。
 *   万一误删了运行时需要的东西，或 `.prisma` 生成的 client 被覆盖成空壳，
 *   症状是上线后才报 "did not initialize yet" —— 那时已经影响用户了。
 * - 在这里失败 = 构建失败，边界成本远低于线上故障。
 *
 * 注意：脚本**不会连接数据库**（Pool 和 PrismaClient 都是懒连接），
 * 所以在没有 DATABASE_URL 的构建环境里也能安全执行。
 */
const REQUIRED_MODULES = [
  // 业务运行时直接依赖的包（与 package.json dependencies 对应）
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/platform-express',
  '@nestjs/observe',
  '@prisma/client',
  '@prisma/adapter-pg',
  'pg',
  'axios',
  'dotenv',
  'exceljs',
  'ffmpeg-static',
  'fluent-ffmpeg',
  'mammoth',
  'mathjs',
  'multer',
  'openai',
  'pdf-parse',
  'reflect-metadata',
  'rxjs',
  'word-extractor',
  'ws',
];

function checkModules() {
  const missing = [];
  for (const mod of REQUIRED_MODULES) {
    try {
      require(mod);
    } catch (e) {
      missing.push(`${mod} -> ${e.code || e.message}`);
    }
  }
  if (missing.length) {
    console.error('❌ 运行时依赖缺失:\n  ' + missing.join('\n  '));
    return false;
  }
  console.log(`✅ 运行时依赖全部可加载（${REQUIRED_MODULES.length} 个）`);
  return true;
}

function checkPrismaClient() {
  try {
    const { Pool } = require('pg');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { PrismaClient } = require('@prisma/client');
    const pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ||
        'postgresql://postgres:postgres@localhost:5432/ai-agent',
    });
    const client = new PrismaClient({ adapter: new PrismaPg(pool) });
    // 生成好的 client 一定是可用的；空壳会在这里抛错
    client.$disconnect();
    console.log('✅ Prisma client 可用（PrismaPg 适配器 + 已生成的 client）');
    return true;
  } catch (e) {
    console.error('❌ Prisma client 不可用: ' + (e.message || e));
    return false;
  }
}

const ok = checkModules() && checkPrismaClient();
if (!ok) process.exit(1);
