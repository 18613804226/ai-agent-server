#!/usr/bin/env node
/**
 * 构建期自检：确认生产镜像里关键依赖和 Prisma client 真的可用。
 *
 * 为什么需要它：
 * - Dockerfile 会 `pnpm install --prod` 砍掉 devDependencies。
 *   万一误删了运行时需要的东西，症状是上线后才报错——那时已经影响用户了。
 * - 在这里失败 = 构建失败，边界成本远低于线上故障。
 *
 * 注意：
 * - 脚本**不会连接数据库**（Pool 和 PrismaClient 都是懒连接），
 *   所以在没有 DATABASE_URL 的构建环境里也能安全执行。
 * - prisma-client 生成器下，PrismaClient 生成在 src/generated 并编译到
 *   dist/generated；@prisma/client 只作为 runtime 使用（其根入口依赖的
 *   node_modules/.prisma/client 不再生成，根 require 会 MODULE_NOT_FOUND），
 *   因此这里探测 runtime 子路径 + 编译后的生成客户端。
 */
const REQUIRED_MODULES = [
  // 业务运行时直接依赖的包（与 package.json dependencies 对应）
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/platform-express',
  '@nestjs/observe',
  // 生成的客户端实际 import 的 Prisma 运行时（CJS，可直接 require）
  '@prisma/client/runtime/client',
  '@prisma/adapter-pg',
  'pg',
  'axios',
  'dotenv',
  'exceljs',
  'ffmpeg-static',
  'fluent-ffmpeg',
  'mammoth',
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

async function checkPrismaClient() {
  try {
    const { Pool } = require('pg');
    const { PrismaPg } = require('@prisma/adapter-pg');
    // dist 里的生成客户端是 ESM，必须动态 import；顺带验证 nest build 产物完整
    const { PrismaClient } = await import('../dist/generated/prisma/client.js');
    const pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ||
        'postgresql://postgres:postgres@localhost:5432/ai-agent',
    });
    const client = new PrismaClient({ adapter: new PrismaPg(pool) });
    // 生成好的 client 一定是可用的；空壳会在这里抛错
    client.$disconnect();
    console.log('✅ Prisma client 可用（PrismaPg 适配器 + dist/generated 客户端）');
    return true;
  } catch (e) {
    console.error('❌ Prisma client 不可用: ' + (e.message || e));
    return false;
  }
}

async function main() {
  const ok = checkModules() && (await checkPrismaClient());
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('❌ 自检异常: ' + (e.stack || e));
  process.exit(1);
});
