# AI Agent Server (Toto Backend)

一个基于 **NestJS**、**Prisma** 和 OpenAI 兼容大模型 API 构建的 AI 助手后端。支持 RAG 知识库、Tavily 实时网页搜索、天气查询、计算器、语音和图片处理、多轮对话及 SSE 流式响应。

## 核心技术

- NestJS + TypeScript
- PostgreSQL + Prisma ORM
- OpenAI SDK（兼容通义千问等 OpenAI 兼容 API）
- pgvector 语义检索与 RAG
- Tavily Search 实时网页搜索
- Server-Sent Events（SSE）流式响应

## 功能说明

### 实时搜索

用户查询微博热搜、新闻、股价、汇率等实时信息时，后端识别实时查询并主动调用 Tavily Search，再把本轮搜索摘要和来源链接交给大模型整理。此流程由后端触发，不依赖模型自行决定是否联网，也不是大模型的 Function Calling。

实时查询不会使用知识库文档或之前的对话回答作为事实来源。模型应根据本轮搜索结果回答并引用来源链接；若搜索未返回可用结果，会提示“没有获取到实时结果”，不让模型根据旧知识猜测。搜索服务未配置或不可用时会返回明确错误。

当前通过关键词识别实时查询，包括“实时、现在、今天、最新、热搜、热榜、新闻、微博、股价、汇率、TOP N”等。

> Tavily 搜索的是可检索的公开网页，不保证微博等平台的官方榜单完整性或实时排名。若需要准确的官方 TOP 榜单，应接入对应平台的官方或授权数据接口。

### Function Calling

聊天接口还支持模型按需调用 `fetchWeatherInfo` 天气查询和 `calculator` 计算器。这些函数工具与上面的 Tavily 后端搜索相互独立。

### 知识库与流式对话

- 支持上传知识库文件、生成向量并进行语义检索；匹配的资料作为 RAG 上下文提供给模型。
- 聊天支持多轮历史消息、图片输入和 SSE 流式输出。
- 支持客户端中断时取消上游模型请求。
- 提供语音识别和语音合成接口。

## 项目结构

```text
src/
├── chat/               # 聊天、实时搜索、函数工具、知识库和语音处理
├── vector/             # 向量生成、存储与语义检索
├── prisma/             # Prisma 数据库服务
├── app.module.ts       # 根模块
└── main.ts             # 应用入口
```

## 快速上手

确保本地已安装 Node.js 和 PostgreSQL。

```bash
# 安装依赖
npm install

# 在项目根目录创建 .env，并填写实际配置
DATABASE_URL="你的 PostgreSQL 连接字符串"
OPENAI_API_KEY="你的大模型 API Key"
OPENAI_BASE_URL="你的 OpenAI 兼容 API 地址"
TAVILY_API_KEY="你的 Tavily API Key"

# 执行数据库迁移并生成 Prisma Client
npx prisma migrate dev
npx prisma generate

# 启动开发服务器
npm run start:dev
```

`TAVILY_API_KEY` 可在 [Tavily](https://tavily.com/) 注册并创建。实时联网搜索必须配置该密钥；不要将真实密钥提交到版本库或公开分享。

## 常用命令

```bash
npm run build
npm run start:dev
npm test
npm run lint
```
