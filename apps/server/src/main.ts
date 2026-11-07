import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule, ObserveInstrument } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 🚀 必须开启 CORS，否则浏览器会拦截跨域的 OPTIONS 预检请求并报 404
  app.enableCors({
    origin: '*', // 允许所有来源（开发环境可以直接这样写）
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    maxAge: 86400, // 👈 关键：这行代码会告诉浏览器缓存预检请求 24 小时
  });
  // ✅ JSON body 按路由分层限宽：
  //    大 body 只放行两条确实需要的路由（/chat/upload-image 的图片 data URL、
  //    /agent/*/session/*/stream 可带 base64 图片），其余路由收紧到 1mb，
  //    缩小「往任意端点塞垃圾占内存」的攻击面。
  //    两个解析器按挂载顺序执行：命中的路由先被大 limit 解析并置位 req._body，
  //    后面的解析器自动跳过；type 不匹配的请求则放行给下一个解析器。
  app.useBodyParser('json', {
    // 8MB 原图的 base64 ≈ 10.7MB，再加 data URL 前缀与 JSON 包装，
    // 12mb 才能让 uploadImage 里的「8MB 友好校验」先于 body limit 生效
    limit: '12mb',
    type: (req) => {
      const path = (req.url || '').split('?')[0];
      return (
        (path === '/chat/upload-image' ||
          /^\/agent\/[^/]+\/session\/[^/]+\/stream\/?$/.test(path)) &&
        String(req.headers['content-type'] ?? '').includes('json')
      );
    },
  });
  // 其余所有路由：本来就是几十 KB 的小 JSON（工具结果上限 4KB，聊天消息是 URL 引用）
  app.useBodyParser('json', { limit: '1mb' });
  // ✅ 部署在 Nginx/网关后面时，不开这个 req.protocol 恒为 http、req.ip 也不对，
  //    uploadImage 生成的图片 URL 会全部指向内网地址（前端 https 页面还会被当混合内容拦掉）
  app.set('trust proxy', true);
  // ✅ 静态托管 uploads 目录，让图片可访问、供大模型识别
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads/',
    maxAge: '1d',
  });
  const port = process.env.PORT || 3000;
  // 👉 核心修改：加上 '0.0.0.0'，允许外部网络和 Docker 映射正常访问！
  await app.listen(port, '0.0.0.0');
  // 🚀 超级醒目的启动成功提示
  console.log('\n======================================================');
  console.log(`🚀 AI Agent 后端服务已成功启动！`);
  console.log(`📍 本地访问地址: http://localhost:${port}`);
  console.log(`📚 RAG 向量检索与大模型对话服务已就绪`);
  console.log('======================================================\n');
}
await bootstrap();
