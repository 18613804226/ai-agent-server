# AI Agent Monorepo

一个 pnpm + Turborepo 管理的 monorepo：共享的 agent 编排器 + NestJS 后端 + Electron/React 编辑器 demo。

## 亮点

### 1. 自研多级大模型策略：成本、速度、可用性的动态平衡

不是「写死一个模型」，而是一套可解释、可降级的级联策略（`packages/agent-orchestrator/src/model-cascade.ts`）：

- **复杂度评分**：按问题长度、代码/公式、多步推理、实时信息、多模态等信号打分，推导候选链
- **免费层优先、付费兜底**：简单文本默认 `glm-4-flash` 起步，复杂任务切 `qwen3.7-flash`，专家任务切 `qwen3.8-max`；常规请求几乎零成本
- **429 原地退避**：限流先在免费层重试（默认 2 次），仍失败才降级，避免一遇限流就白烧付费额度
- **只在建连阶段降级**：一旦开始吐字就不再换模型，杜绝把重复内容推给前端
- **智谱单并发锁**：免费层限 1 并发，全局串行从源头避开 429
- **多模态路由**：带图请求直接走视觉模型
- **附件拒答守卫**：`ContentGate` 先扣留开头内容，命中「无法读取附件」这类拒答就换模型重试，用户看不到那句拒答
- **路由决策可视化**：把「为什么选这个模型」作为 `thought` 推给前端

### 2. 编排器与宿主解耦：一套循环，多种运行形态

`packages/agent-orchestrator` 是纯 TypeScript，只依赖 `openai`：

- 不 import `@nestjs/*` / `@prisma/*`，不碰数据库、HTTP、文件系统
- 对外是 `AsyncGenerator<AgentEvent>`（`thought | content | tool_call | tool_result | file_edit | error | done`），`done` 额外带 `finishReason / truncated`，传输无关
- 配置全部注入（`getClient` / `modelConfig` / `showRoutingThought` / `rateLimitRetries` / `zhipuLock` 及各超时参数），编排器本身不读 `process.env`
- 同一个编排器既能跑在 NestJS 后端，也能跑在 Electron 主进程做本地编辑（本地模式已上线）
- `@Global` 的 `AgentModule` 保证全进程唯一实例，智谱并发锁不会被多个宿主绕过
- 策略层内置：模型建连/流空闲/智谱锁/工具执行超时、工具参数校验、结果截断、断连取消
- 上下文治理：旧工具结果与旧 `tool_call` 参数压缩成预览，控制多轮工具调用的输入 token
- 工具执行优化：只读工具并行执行；重复调用返回引用不重复执行；大文件转 artifact 句柄，`read_artifact` 按需取全文
- 编辑器闭环：`verifyAfterTools` 自动跑 `typecheck/lint`，`verify_workspace` 工具可手动验证（支持 `scripts` 覆盖，如 `test`）；验证器把 tsc / ESLint 输出解析成结构化诊断（`file:line:col [severity] message`）回填给模型
- 审批开关：设置里可切换「总是询问 / 自动放行」；审批弹窗显示 before/after diff，本轮改动可一键撤销
- 断点续跑：本地和云端都支持暂停 / 继续 / 取消；状态机（`idle/running/paused/done/failed/cancelled`）在 `@repo/agent-orchestrator` 的 `run-state` 里，本地检查点持久化到 `userData/agent-run.json`，服务端按 sessionId 维护
- 编辑器上下文：当前文件、选区、文件列表（repo map）注入 system prompt；云端模式 `done` 事件会带上客户端收集的本轮改动

### 3. 工具调用解耦：编排器不认识任何具体工具

- 工具契约只有 `RegisteredTool = { definition, handler }`
- 编排器按名字查找 handler，未知工具返回兜底文案，**零硬编码工具名**
- 每个 agent 只注册自己的工具集：`editor`（文件/搜索/终端）、`general`（天气/计算/联网/农历节日）、`chat`（复用 general 的天气/计算/农历节日）
- 新增 agent 只需「工具集 + prompt + 注册」，循环、级联、流式工具调用全部复用
- `packages/editor-agent` 把编辑器工具做成 `createEditorTools(roots)` 工厂，后端和 Electron 主进程共用同一份实现
- `packages/general-agent` 把通用工具（`createGeneralTools` / `createChatTools`）、prompt 和 `festival_info` 收敛到一处，后端 `/chat` 与 `/agent/general` 不再各写一份

### 4. 多 agent 共用一个后端，前端可跨仓库

- 通用路由 `/agent/:agentId/...`，路径里的 id 决定用哪套工具集
- `editor` 与 `general` 共享同一个编排器实例
- `packages/agent-types` 定义跨仓库 SSE 契约，另一个 demo 的前端在独立仓库也能安全消费

### 5. 从 2474 行 God Class 到职责拆分

`chat.service.ts` 从 2474 行拆成 9 个文件，每一步都保持构建与测试全绿：

| 文件 | 职责 | 行数 |
|------|------|------|
| `chat.service.ts` | 流式对话编排（RAG + 历史 + prompt + 落库） | 725 |
| `attachment.service.ts` | 附件解析/落盘/预览/清扫 | 733 |
| `image.service.ts` | 图片上传/压缩/安全校验/孤儿清扫 | 345 |
| `speech.service.ts` | TTS + ASR | 290 |
| `knowledge.service.ts` | 知识库上传/切分/向量化 | 234 |
| `session.service.ts` | 会话 CRUD | 128 |
| `excel.service.ts` | Excel 错误识别 | 62 |
| `chat-prompt.ts` | 系统提示 + token 估算（纯函数） | 51 |
| `filename.ts` | multipart 文件名修复 | 47 |

### 6. 工程化与可验证

- pnpm workspace + Turborepo，按依赖顺序构建（packages → apps）
- 共享包独立构建、独立测试
- **188 个后端单测 + 93 个编排器单测 + 42 个编辑器工具单测 + 23 个通用工具单测**，lint 0 errors
- Docker 按 workspace 分层构建：只装 `@repo/server` 子图，不拉 Electron/React
- Electron + React 桌面 demo（Monaco 编辑器），SSE 流式渲染

## 结构

```text
apps/
  server/                 # NestJS 后端：共享编排器接入层 + 各 agent（editor / general）
  editor-desktop/         # Electron + React 编辑器 demo，连 /agent/editor/... 的 SSE
packages/
  agent-orchestrator/     # 纯 TS agent 编排器（模型级联 + 工具循环），无 Nest/Prisma 依赖
  editor-agent/           # 编辑器工具 + prompt，root 可注入（后端 / Electron 共用）
  general-agent/          # 通用工具（天气/计算/联网/农历节日）+ prompt + generalAgent 定义
  agent-types/            # 跨仓库共享的事件 / 工具契约类型
```

### 后端（`apps/server`）

- `src/agent/`：全局唯一的 `ModelClients` + `AgentOrchestrator`（`@Global` 模块）
- `src/agents/`：agent 注册与通用 SSE 路由
  - `editor/`：`read_file` / `write_file` / `edit_file` / `apply_patch` / `delete_file` / `move_file` / `create_directory` / `list_dir` / `search_files` / `glob` / `run_terminal` / `git_status` / `git_diff` / `read_artifact`
  - `general`（来自 `@repo/general-agent`）：`fetchWeatherInfo` / `calculator` / `web_search` / `festival_info`
  - `editor`（来自 `@repo/editor-agent`）：文件读写 / 搜索 / glob / 终端 / git / `verify_workspace` / `read_artifact`
- `src/chat/`：聊天、RAG、附件、语音、知识库、Excel 检查（已按职责拆分，见上表）

### 编排器（`packages/agent-orchestrator`）

模型级联、降级、流式 `tool_calls` 累积、工具循环都在这一个包里，宿主只提供
工具集 + 系统提示 + 事件消费方式。详见 `apps/server/README.md` 的「共享编排器」。

## 环境要求

- Node.js >= 20（推荐 22+）
- pnpm 9+
- PostgreSQL（带 pgvector 扩展）

## 安装

```bash
pnpm install
```

`apps/server` 的 `postinstall` 会自动执行 `prisma generate`。若安装时用了
`--ignore-scripts`，手动补一次：

```bash
pnpm --filter @repo/server exec prisma generate
```

## 开发

```bash
# 构建所有包（turbo 按依赖顺序：packages → apps）
pnpm build

# 跑所有测试
pnpm test

# 所有包 lint
pnpm lint
```

### 后端

```bash
# 在 apps/server/.env 配置 DATABASE_URL / OPENAI_API_KEY / OPENAI_BASE_URL / TAVILY_API_KEY
# 可选策略参数：
#   CHAT_MODEL_CONNECT_TIMEOUT_MS / CHAT_MODEL_IDLE_TIMEOUT_MS
#   CHAT_ZHIPU_LOCK_TIMEOUT_MS / CHAT_TOOL_TIMEOUT_MS / CHAT_TOOL_MAX_RESULT_CHARS
#   CHAT_CONTEXT_MAX_INPUT_TOKENS / CHAT_CONTEXT_KEEP_RECENT_TOOLS
#   CHAT_CONTEXT_KEEP_RECENT_TOOL_ROUNDS
#   CHAT_CONTEXT_TOOL_PREVIEW_CHARS / CHAT_CONTEXT_OLD_MESSAGE_PREVIEW_CHARS
#   AGENT_TOOL_WAIT_TIMEOUT_MS（云端模式等待客户端执行工具的上限）
pnpm --filter @repo/server exec prisma db push   # 同步表结构（本项目无 migrations）
pnpm --filter @repo/server start:dev             # http://localhost:3000
```

### 桌面 demo

```bash
# 先确保后端在 3000 端口
pnpm --filter @repo/editor-desktop dev
```

两种模式都编辑本地项目：本地模式在 Electron 主进程跑编排器；云端模式把编排器放到
后端，工具调用再通过 `tool_request` 回传到客户端本地执行。后端地址写死在
`apps/editor-desktop/src/renderer/src/cloud.ts`（`CLOUD_BACKEND_URL`），顶栏可切换
本地/云端与模型。

本地模式的 API Key 放在 `apps/editor-desktop/.env`（参考 `.env.example`），例如
`GLM_API_KEY=...`；默认只显示一个免费模型 `glm-4-flash`，更多提供商/模型在设置里添加。

### 另一个智能体 demo

它的前端在独立仓库，通过 HTTP/SSE 连本后端的 `/agent/general/...`。
事件契约见 `packages/agent-types`，改动属于破坏性变更。

## Agent 接口

```http
GET  /agent/list                              # 列出可用 agent
POST /agent/:agentId/session                  # 建会话
GET  /agent/:agentId/sessions                 # 会话列表
POST /agent/:agentId/session/:id/stream       # SSE 流式对话
POST /agent/:agentId/session/:id/pause        # 暂停当前运行（保存检查点）
POST /agent/:agentId/session/:id/cancel       # 取消当前运行（检查点保留可继续）
GET  /agent/:agentId/session/:id/state        # 查询运行态与检查点
POST /agent/:agentId/session/:id/tool-result  # 云端模式：回传客户端工具执行结果

GET  /agent/editor/workspace/tree             # 工作区目录树（桌面端用）
GET  /agent/editor/workspace/file?path=...    # 工作区文件内容
```

SSE 事件：`thought | content | error | done`（`/chat` 接口额外有 `sources`）。
`/agent` 接口额外透传结构化的 `tool_call`（带 `args` / `index`）/ `tool_result` / `file_edit`，
供前端展示工具操作块与编辑器逐行流式编辑；云端模式还有 `tool_request`（后端请客户端执行工具）；
`/chat` 接口仍把工具调用映射成 `thought` 文案。

## 部署

Docker 构建上下文是仓库根（要拿到 `packages/`）：

```bash
docker compose -f docker-compose.4001.yml --env-file apps/server/.env build
docker compose -f docker-compose.4001.yml --env-file apps/server/.env up -d --no-build
```

> 注意：`.env` 位于 `apps/server/.env`，不是仓库根。

## 路线图

- [x] 共享编排器 + 多 agent + 工具解耦
- [x] `chat.service.ts` 职责拆分（2474 → 725 行）
- [x] Electron + React 编辑器 demo（云端工作区）
- [x] 本地编辑模式：编排器 + 工具跑在 Electron 主进程，直接编辑本地项目
- [x] 本地 / 云端模式切换（同一套 `AgentEvent` 契约，换 Transport + WorkspaceProvider）
- [x] 编辑器工具补齐：`apply_patch` / `delete_file` / `move_file` / `create_directory` / `glob` / `git_status` / `git_diff`
- [x] 已修改文件对比：聊天面板列出本轮改动 + 行级 diff（写后展示）
- [x] Monaco 编辑器 + Cline 风格逐行流式编辑（AI 改代码时一行一行往下刷）
- [x] 结构化工具操作块：读/写/编辑/搜索/终端等每个操作一张卡片，结果可折叠
- [x] 客户端配置：本地/云端模型、Base URL、后端地址；模型可在顶栏随时切换
- [x] 验证闭环：`verifyAfterTools` 自动跑 typecheck/lint，诊断结构化回填
- [x] 审批 + 撤销：写/删/危险命令执行前审批，弹窗显示 before/after diff，本轮改动可一键撤销
- [x] 断点续跑：本地 / 云端暂停、继续、取消；检查点持久化（本地 `userData`）
- [x] 编辑器上下文：当前文件、选区、repo map 注入 system prompt
- [x] 工具并行 + artifact：只读工具并行、重复调用引用、大文件 artifact 句柄
- [x] 写前审批弹窗显示 before/after diff + 允许/拒绝
- [ ] diff 逐段接受/拒绝
- [ ] 本地模式的会话历史持久化

## 包管理器

统一使用 pnpm（workspace）。不要混用 npm / yarn，也不要提交 `package-lock.json`。
