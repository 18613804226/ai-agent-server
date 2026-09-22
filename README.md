# 🤖 AI Agent Server (Toto Backend)

一个基于 **NestJS**、**Prisma** 和 **OpenAI / 通义千问大模型 API** 构建的高性能、全栈 AI 智能助手后端服务。支持 RAG（检索增强生成）、天气工具智能调度、多轮对话历史上下文管理以及极速流式（Stream）响应。

---

## 🚀 核心技术栈

* **核心框架**: NestJS (TypeScript)
* **数据库 & ORM**: PostgreSQL + Prisma ORM
* **大模型集成**: OpenAI SDK (兼容通义千问 `qwen` 系列大模型)
* **向量检索**: 自研 VectorService（支持语义检索与 RAG 补充资料挂载）
* **通信协议**: Server-Sent Events / Stream 实时流式传输

---

## ✨ 核心亮点与优化

1. **极致响应速度（并发提速）**：
   * 采用 `Promise.all` 将用户消息入库、向量检索（RAG）以及历史消息查询进行**并发执行**，彻底摆脱串行等待，大幅压低首字响应时间（TTFT）。
2. **意图识别与智能工具调度（Tool Calling）**：
   * 内置轻量正则意图拦截与大模型两阶段决策机制。普通闲聊或身份问答直接跳过工具判断走极速流；当用户明确查询天气时，按需动态挂载 `fetchWeatherInfo` 工具，防止幻觉调用。
3. **安全严谨的网关协议对齐**：
   * 自动过滤并加固大模型对话历史，强制校验并确保发送给大模型的 `messages` 列表末尾永远以 `user` 角色收尾，完美规避各大模型网关常见的 `400 InvalidParameter` 报错。
4. **稳定可靠的中断与错误处理**：
   * 支持前端一键“停止生成”（通过 `AbortController` 联动拦截），并在生成流中实时侦测客户端断开状态，避免无用计算与数据库脏数据写入。

---

## 📦 项目结构

```text
src/
├── chat/               # 聊天核心业务模块（包含 Stream 流式、工具调度）
├── vector/             # 向量检索与 RAG 知识库挂载服务
├── prisma/             # 数据库连接与 Prisma Client 管理
├── app.module.ts       # 根模块
└── main.ts             # 应用入口