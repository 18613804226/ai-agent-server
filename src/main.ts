import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 🚀 必须开启 CORS，否则浏览器会拦截跨域的 OPTIONS 预检请求并报 404
  app.enableCors({
    origin: '*', // 允许所有来源（开发环境可以直接这样写）
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
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
