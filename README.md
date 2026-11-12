# AI Agent Monorepo

> 一个 pnpm + Turborepo 管理的 monorepo：共享的 agent 编排器 + NestJS 后端 + Electron/React 编辑器 demo。

## 这是什么

monorepo 的核心是**把 agent 循环做成与宿主无关的共享包**：同一套编排逻辑既能跑在 NestJS 后端，也能跑在 Electron 桌面端。

| 路径 | 类型 | 职责 |
|------|------|------|
| `packages/agent-orchestrator` | 包 | 纯 TS agent 编排器：模型级联 + 工具循环 + 流式事件，不依赖 Nest/Prisma/HTTP |
| `packages/editor-agent` | 包 | 编辑器工具 + prompt（`createEditorTools(root)`），后端与桌面端共用 |
| `packages/general-agent` | 包 | 通用工具（天气/计算/联网/农历节日）+ prompt |
| `packages/agent-types` | 包 | 跨仓库 SSE 事件 / 工具契约类型 |
| `apps/server` | 应用 | NestJS 后端：`/chat`（RAG/附件/语音）+ `/agent/:agentId/...`（editor / general） |
| `apps/editor-desktop` | 应用 | Electron + React 编辑器 demo，本地 / 云端双模式 |

编排器对外是 `AsyncGenerator<AgentEvent>`（`thought | content | tool_call | tool_result | file_edit | approval_request | browser_open | error | done`），配置全部注入，宿主只提供工具集 + 系统提示 + 事件消费方式。

## 仓库结构

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

## 快速开始

环境要求：Node.js >= 20（推荐 22+）、pnpm 9+、PostgreSQL（带 pgvector 扩展）。

```bash
pnpm install          # apps/server 的 postinstall 会自动 prisma generate
pnpm build            # turbo 按依赖顺序：packages → apps
pnpm test             # 所有包测试
pnpm lint             # 所有包 lint
```

若安装时用了 `--ignore-scripts`，手动补一次：

```bash
pnpm --filter @repo/server exec prisma generate
```

## 目录

- [apps/server — AI Agent Server](#appsserver--ai-agent-server)
- [apps/editor-desktop — Editor Desktop](#appseditor-desktop--editor-desktop)
- [packages — 共享包](#packages--共享包)
- [部署](#部署)
- [路线图](#路线图)

---

## apps/server — AI Agent Server

> 基于 NestJS + Prisma + OpenAI 兼容大模型 API 的后端，支持 RAG 知识库、实时联网搜索（Tavily / 博查可切换）、天气、计算器、语音、图片、多轮对话与 SSE 流式响应。


一个基于 **NestJS**、**Prisma** 和 OpenAI 兼容大模型 API 构建的 AI 助手后端。支持 RAG 知识库、实时网页搜索（Tavily / 博查可切换）、天气查询、计算器、语音和图片处理、多轮对话及 SSE 流式响应。

### 核心技术

- NestJS + TypeScript
- PostgreSQL + Prisma ORM
- OpenAI SDK（兼容通义千问等 OpenAI 兼容 API）
- pgvector 语义检索与 RAG
- 实时网页搜索（Tavily / 博查可切换，失败自动降级）
- Server-Sent Events（SSE）流式响应
- 共享 agent 编排器（`@repo/agent-orchestrator`：模型级联 + 工具循环）
- 多 agent 路由（`editor` / `general`，工具集可插拔）

### 功能说明

#### 实时搜索

用户查询微博热搜、新闻、股价、汇率等实时信息时，后端识别实时查询并主动调用联网搜索，再把本轮搜索摘要和来源链接交给大模型整理。此流程由后端触发，不依赖模型自行决定是否联网，也不是大模型的 Function Calling。

实时查询不会使用知识库文档或之前的对话回答作为事实来源。模型应根据本轮搜索结果回答并引用来源链接；若搜索未返回可用结果，会如实说明无法查证，不让模型根据旧知识猜测。

当前通过关键词识别实时查询，包括"实时、现在、今天、最新、热搜、热榜、新闻、微博、股价、汇率、TOP N"等。

**联网 provider 可切换**（`WEB_SEARCH_PROVIDER`，默认 `tavily`）：

| provider | 说明 | 必填 |
|---|---|---|
| `tavily` | 默认，境外 Tavily，保持既有行为 | `TAVILY_API_KEY` |
| `bocha` | 国内博查，中文源更全、跨境延迟更低 | `BOCHA_API_KEY` |

两者都归一化成同一份 `WebSearchResult { title, url, content, publishedDate? }`，`formatWebSearchContext`、`sources` 事件和提示词都不用改。博查按官方开放平台 `POST https://api.bochaai.com/v1/web-search` + `Authorization: Bearer`，把响应 `webPages.value[]` 的 `name / url / summary|snippet / datePublished` 映射过来；`BOCHA_API_URL` 可覆盖 endpoint（换域名或走代理），`WEB_SEARCH_TIMEOUT_MS` 控制单次超时（默认 15000）。未配 provider 或写了未知值一律回落 `tavily`。

**来源统一回流**（`CHAT_SEARCH_SESSION`，默认 `on`）：一轮对话建一个 `SearchSession`，后端预检索和模型主动调 `web_search` 都往里写结构化结果；`sources` 事件、落库 `sources` 与 `done.sourcesCount` 全部由它派生，正文里的 `[n]` 编号跨多次检索全局连续、同 URL 去重。因此「关键词没命中、模型自己补搜」的轮次也会正常下发来源列表。设 `CHAT_SEARCH_SESSION=off` 可一键回退到「只有后端预检索才下发 sources」的旧行为，便于线上止血。

**失败自动降级，不再拖垮整轮**：`searchWeb()` 统一打点并抛错，主链路对联网这一支做了 `.catch(() => [])`，推一帧 `⚠️ 联网检索暂不可用，以下回答未包含实时信息。`，再走已有的 `liveSearchEmpty` 分支照常请求模型（并打开工具让模型如实说明）；模型主动调 `web_search` 工具失败时，工具也返回「本轮没有可引用的实时资料」而不是抛错打断工具循环。以前联网 API 一超时整轮就抛错，默认还会切成离线演示回放，用户问实时问题却收到预录答案。

日志格式（不打印 query 和 API Key）：

```text
[web-search] {"provider":"tavily","ok":true,"results":8,"durationMs":1234}
[web-search] {"provider":"bocha","ok":false,"results":0,"durationMs":15001,"code":"ECONNABORTED","reason":"..."}
```

按 `ok` 统计失败率、按 `durationMs` 看 P95，跑一周再决定要不要把默认切到国内。

> 搜索的是可检索的公开网页，不保证微博等平台的官方榜单完整性或实时排名。若需要准确的官方 TOP 榜单，应接入对应平台的官方或授权数据接口。

#### Function Calling

聊天接口还支持模型按需调用 `fetchWeatherInfo` 天气查询和 `calculator` 计算器。这些函数工具与上面的后端联网搜索相互独立。

#### 知识库与流式对话

- 支持上传知识库文件、生成向量并进行语义检索；匹配的资料作为 RAG 上下文提供给模型。
- 知识库文件可单独启用或禁用；禁用后文件和向量切片保留，但不会参与任何向量检索。
- 聊天支持多轮历史消息、图片输入和 SSE 流式输出。
- 支持客户端中断时取消上游模型请求。
- 提供语音识别和语音合成接口。

#### APP 端提示词与排版

`/chat/:id/stream` 按客户端平台选择提示词：登录时上报 `platform: 'ios' | 'android'`（也识别 `app` / `mobile` 等别名），或直接在请求体带 `platform`，请求体优先。判定为 APP 端时：

- 系统提示词前置一段移动端输出规范：**整段紧凑输出，不留任何空白行**——直给答案、不复述问题；整条回复写成一段，不主动换行、不分段、不用短标题行、不把分点拆成多行，绝对不出现 `\n\n`；开头、结尾都不留空白行，结尾也不另起一段补追问或总结。内容照常充分、把话说清楚，但不靠分段撑长度，也不要刻意压短或只回结论，补充内容必须有依据、不编细节。原有的工具、附件、知识库来源与联网引用规则全部保留。
- **联网 URL 不再贴进正文**：APP 规范明确禁止裸 URL 和 `[https://…]` 这种方括号包链接，改用 `[1]` / `[2]` 数字角标（对应【本轮联网搜索结果】的序号）；服务端在模型出第一个字之前就把结果的 `url` / `title` 放进 `sources` 事件和 `Message.sources`（`kind: 'web'`），客户端要渲染可点击链接从这里取。Web / 桌面端仍用 `[来源标题](URL)` 形式的 Markdown 链接。
- 回复额外做排版兜底清洗：流式逐 chunk 与落库全文共用同一套空行规则——**任何位置的连续换行（含跨 chunk 边界、CRLF、只夹空格的伪空行、代码块内）一律压成单个换行**，首尾空白去掉，正文里不留下 `\n\n`（客户端会按它切块并补一行空行，一条消息就会被切成两块、末尾还会多出一块空白）。流式清洗器还会把**尾部空白与半截 URL 扣住不发**，所以末尾不会偶发多出一行空白。APP 正文里残留的裸 URL / 方括号包 URL 由同一套清洗兜底收掉，Markdown 图片 `![alt](…)` 会原样保留，不会洗坏历史图片。

Web / 桌面端或不传 `platform` 时不叠加 APP 排版规范与排版清洗。提示词与清洗逻辑在 `apps/server/src/chat/chat-prompt.ts`，单测见 `apps/server/src/chat/chat-prompt.spec.ts`。
APP 端同样展示模型路由决策（`模型选择：…`），`🔧 调用工具`、`↩️ 工具结果`、`🔎 已联网检索`、附件解析与降级提示也全部保留，面试 Demo 能完整呈现模型分层和 Agent 工具链；只收掉「回答达到长度上限」这类异常警告。

#### 流式事件（SSE）

`/chat/:id/stream` 每帧 `data` 是一个 JSON 对象，`type` 取值：

- `thought` / `content` / `error`：`content` 为文本；错误文案已收敛，不含内部报错原文。
- `sources`：`sources` 为引用来源数组。知识库来源形如 `{ fileId, fileName }`；联网来源形如 `{ kind: 'web', index, title, url, publishedDate? }`，`index` 对应正文里的 `[1]` / `[2]` 角标。`usedInThisReply` 只在正文实际出现对应 `[n]` 时为 `true`，未被引用的联网来源为 `false`。
- `tool_call`：`{ name, args, index }`，`args` 是入参摘要（最长 500 字）。
- `tool_result`：`{ name, index, result, resultLength, durationMs, status }`；`result` 为 200 字预览、`resultLength` 为原长、`durationMs` 为从 call 到 result 的墙钟耗时，`status` 取 `success | error | cached | denied`。按 `index` 与 `tool_call` 配对即可渲染可展开的工具卡片。
- `done`：`{ tokens, model, completionTokens, inputTokens, outputTokens, reasoningTokens, cachedTokens, finishReason, truncated, ttftMs, firstAnswerTokenMs, generationDurationMs, thoughtDurationMs, answerDurationMs, durationMs, sourcesCount, historyKept, historyDropped, digestUsed }`。`inputTokens` / `outputTokens` / `reasoningTokens` 直接取上游 usage（`prompt_tokens` / `completion_tokens` / `completion_tokens_details.reasoning_tokens`，上游不报思考 token 时按思考/正文字符占比分摊），正文 token = `outputTokens - reasoningTokens`；`cachedTokens` 是命中 prompt cache 的输入，`0` 表示上游有 usage 但本轮未命中，仅本轮无用量数据（回放 / 早退）时为 `null`。`ttftMs` 是首个 token（含思考）延迟，`firstAnswerTokenMs` 是正文首字延迟；`generationDurationMs` 是思考 + 正文的吐字时长（各轮「首 token → 末 token」累加，工具执行与轮次间隔不计入），**t/s 按 `outputTokens / (generationDurationMs / 1000)` 计算**；`thoughtDurationMs` / `answerDurationMs` 分别是思考与正文的吐字耗时；`durationMs` 是服务端整轮耗时（含检索 / 工具 / 落库，不含客户端网络与打字机）。后三项是上下文记忆指标（本轮带入的历史条数、被裁掉的条数、是否启用滚动摘要）。
- `ping`：每 15 秒一帧心跳，避免长静默期被网关断开，客户端忽略即可。

兼容性：结构化 `tool_call` / `tool_result` 是新增事件，原有的 `🔧 调用 …` / `↩️ …` 文本 `thought` 仍同时推送，老版 APP 无需改动也能展示工具链。出错时推一帧收敛文案后正常结束流，不再用 `subscriber.error()` 触发 EventSource 反复重连。

#### 上下文记忆：滚动摘要与窗口治理

- 历史取最近 30 条，再按 `CHAT_MAX_INPUT_TOKENS`（默认 6000）从最新往前装；装不下的旧消息不再直接丢弃，而是本地提取成 `【此前对话要点】` 注入 system prompt，优先保留用户给过的约束（「以后都…」「别…」「用摄氏度」），最多 300 字。纯本地生成，不额外请求模型、不增加首字延迟；没有裁剪时 system prompt 与原来一字不差。
- 实时查询的历史窗口由 `CHAT_LIVE_HISTORY_MESSAGES` 控制（默认 12 条 ≈ 6 轮，最小 6、最大 30），长会话仍由 token 预算兜底。
- 历史来源状态按裁剪前的完整历史统计，更早回答引用过的停用文档不会被漏掉。
- 附件元数据里额外落 300 字要点，注入 `【此前附件要点】`；原文依旧只在临时存储里、到期即弃，但下一轮「再展开第二点」能接上。同一附件按摘要去重，无字段变更、不需要 migration。
- 指代类追问（「刚才那点再说清楚一点」）复用上一轮 RAG 命中，5 分钟内不再重复 embedding + 向量检索，并推一帧 `📚 沿用上一轮检索到的知识库资料。`
- 纯文本追问历史图（「刚才那张图里的字」）会识别指代并强制走视觉档、还原历史图；历史图已清理时自动退回文本档，不白走付费视觉模型。
- 两套预算同源但语义不同：宿主 `CHAT_MAX_INPUT_TOKENS` 是初始窗口，编排器是「初始窗口 + 18000 工具循环余量」，可用 `CHAT_CONTEXT_MAX_INPUT_TOKENS` 显式覆盖。改的是服务端 `orchestrator.factory.ts` 的注入值，**编辑器有自己的 `AgentOrchestrator` 实例且不传 `contextOptions`，不受影响**；包内默认值也没动。
- `done` 事件里的 `historyKept` / `historyDropped` / `digestUsed` 让面试官能直接看到本轮用了多少历史、是否启用了摘要。
- **用户画像（跨会话）**：只有用户显式说「记住…」「以后…」「统一用…」才记录，且只认四类白名单——称呼 / 输出格式 / 语言 / 单位；事实类内容一律不记，否定句（「别用列表」）也不记。本地正则抽取、不调模型，同类型覆盖、最多 4 条，存 `Device.preferences`（新增字段，部署前跑 `prisma db push`）。命中时推一帧 `🧠 已记住偏好：…`；`GET /chat/profile/preferences` 可查看、`DELETE /chat/profile/preferences` 一键清空；设 `CHAT_USER_PROFILE=off` 则完全不记不注入。

### 项目结构

```text
src/
├── agent/              # 全局共享的编排器（ModelClients + AgentOrchestrator）
├── agents/             # 各 agent 的定义与通用路由
│   ├── editor/         # Cursor 式代码助手：文件读写/搜索/终端工具
│   ├── general/        # 通用助手：天气/计算器/联网搜索
│   ├── runner.ts       # 组装消息 + 推导候选链 + 调编排器
│   ├── registry.ts     # agent id → 定义
│   └── controller.ts   # /agent/:agentId/... 通用 SSE 路由
├── chat/               # 聊天与 RAG（已按职责拆分，见下）
├── vector/             # 向量生成、存储与语义检索
├── prisma/             # Prisma 数据库服务
├── app.module.ts       # 根模块
└── main.ts             # 应用入口
```

#### chat 模块拆分

`chat.service.ts` 从 2474 行 God Class 拆成 9 个文件，每一步都保持测试全绿：

| 文件 | 职责 |
|------|------|
| `chat.service.ts` | 流式对话编排（RAG + 历史 + prompt + 落库） |
| `attachment.service.ts` | 附件解析/落盘/预览/清扫 |
| `image.service.ts` | 图片上传/压缩/安全校验/孤儿清扫 |
| `knowledge.service.ts` | 知识库上传/切分/向量化 |
| `speech.service.ts` | TTS + ASR |
| `excel.service.ts` | Excel 错误识别 |
| `session.service.ts` | 会话 CRUD |
| `chat-prompt.ts` | 系统提示 + token 估算（纯函数） |
| `filename.ts` | multipart 文件名修复 |

#### 共享编排器

模型级联、降级、流式 tool_calls 累积、工具循环全部在共享包
`packages/agent-orchestrator`（`@repo/agent-orchestrator`）里，`ChatService` 和
`AgentRunner` 都只是它的宿主：

- `AgentOrchestrator.run(input, gate?)`：`AsyncGenerator<AgentEvent>`，事件为
  `thought | content | tool_call | tool_result | error | done`
- `AgentModule`（`@Global`）提供全进程唯一的 `ModelClients` + `AgentOrchestrator`，
  保证智谱免费层「限 1 并发」的锁是全局的
- 配置通过 `OrchestratorConfig` 注入（`getClient` / `modelConfig` /
  `showRoutingThought` / `rateLimitRetries` / `zhipuLock`），编排器本身不读 `process.env`
- `ContentGate` 是可选钩子，chat 模块用它做「附件拒答 → 换模型重试」

#### 多 agent

新增一个 agent 只需两步：在 `src/agents/<id>/` 下定义工具集与系统提示，然后在
`src/agents/registry.ts` 里注册。循环、模型级联、流式工具调用全部复用共享编排器。

```http
GET  /agent/list                              # 列出可用 agent
POST /agent/:agentId/session                  # 建会话
GET  /agent/:agentId/sessions                 # 会话列表
POST /agent/:agentId/session/:id/stream       # SSE 流式对话
```

内置两个 agent：

| id | 工具 | 用途 |
|----|------|------|
| `editor` | `read_file` / `write_file` / `edit_file` / `list_dir` / `search_files` / `run_terminal` / `open_in_browser` | Cursor 式代码助手 |
| `general` | `fetchWeatherInfo` / `calculator` / `web_search` | 通用助手 |

`editor` agent 的文件工具被限制在 `AGENT_WORKSPACE_ROOT`（默认 `<cwd>/workspace`）内，
越界路径与破坏性命令会被拒绝。桌面端画文件树/读文件用：

```http
GET /agent/editor/workspace/tree
GET /agent/editor/workspace/file?path=src/index.ts
```

```bash
AGENT_WORKSPACE_ROOT=/path/to/workspace   # 可选，默认 apps/server/workspace
```

### 快速上手

确保本地已安装 Node.js 和 PostgreSQL。

本应用位于 monorepo 的 `apps/server`，依赖共享包 `@repo/agent-orchestrator`。

```bash
# 在仓库根目录安装依赖（pnpm workspace）
pnpm install

# Prisma Client 由 apps/server 的 postinstall 自动生成；
# 若安装时加了 --ignore-scripts，可手动补一次：
pnpm --filter @repo/server exec prisma generate

# 在 apps/server 目录创建 .env，并填写实际配置
DATABASE_URL="你的 PostgreSQL 连接字符串"
OPENAI_API_KEY="你的大模型 API Key"
OPENAI_BASE_URL="你的 OpenAI 兼容 API 地址"
TAVILY_API_KEY="你的 Tavily API Key"          # 默认 provider；用国内博查则改 WEB_SEARCH_PROVIDER=bocha 并填 BOCHA_API_KEY

# 同步数据库表结构（本项目无 migrations，用 db push）
pnpm --filter @repo/server exec prisma db push

# 启动开发服务器
pnpm --filter @repo/server start:dev
```

`TAVILY_API_KEY` 可在 [Tavily](https://tavily.com/) 注册并创建；切到 `WEB_SEARCH_PROVIDER=bocha` 时改填 `BOCHA_API_KEY`（[博查开放平台](https://open.bochaai.com/)）。两者留空时联网检索会失败并自动降级为「无实时资料」，不会让整轮对话报错。不要将真实密钥提交到版本库或公开分享。

### 模型分层与级联调度

单模型方案下，简单问答和复杂请求付同样的钱。本项目按 **Model Cascade（FrugalGPT）** 思路做了两层优化：

1. **成本分层**：免费层（智谱 GLM 免费额度）前置承载大部分请求，付费层（DashScope qwen）只做兜底。
2. **多通道降级**：主模型请求失败（限流、5xx、模型不存在）时自动切换到候选链上的下一个模型，仅重试建连阶段，不重试已吐字的中途失败，避免给客户端推送重复内容。
3. **免费层并发串行**：智谱免费层只允许 1 个并发请求，多用户同时发消息会直接触发 429。进程内用一把全局锁把智谱请求串起来（锁持有到整条流读完），qwen 付费层不受影响。若仍偶发限流，还会原地退避重试 2 次再降级。

请求按以下规则分流：

```text
含图片/视频？
  ├─ 是 → qwen3.7-flash（全模态，付费）
  └─ 否（纯文本）→ 按规则判定复杂度，三级分流：
        简单(得分<3)  → glm-4.5-flash（免费）→ qwen3.7-flash 兜底
        复杂(3~4)    → qwen3.7-flash
        高难度(>=5)  → qwen3.8-max-0902 → qwen3.7-flash 退路
```

阿里云侧所有模型（`qwen3.7-flash` / `qwen3.7-plus` / `qwen3.8-max-0902`）共用同一套 `OPENAI_API_KEY` + `OPENAI_BASE_URL`，**无需额外配置**，只是模型名不同。

复杂度用**纯规则**判定（输入长度、是否多问题、代码/计算/结构化输出特征、实时信息查询等），命中项会写进日志的 `[模型分层]` 行，便于回头调整阈值。规则不引入额外模型调用，零开销。

#### 为什么视觉和复杂文本不用 GLM 免费款

| 型号 | 实测问题 | 结论 |
|------|---------|------|
| `GLM-4.7-Flash` | 高峰期首字 53s→240s（免费池排队） | 不可用 |
| `GLM-4.6V-Flash` | 指令遵循弱，会把图片问题胡编成不存在的工具调用（如 `fetchImageContent`） | 质量不可用 |
| `glm-4.5-flash` | 快（2.7s）、回答稳 | ✅ 简单文本默认档 |

级联降级只对**报错**生效（限流、5xx、模型不存在），对「回答质量差但返回 200」无能为力。所以质量不达标的模型不能靠降级兜底，只能从默认档位里排除——这也是视觉档直接选 qwen 的原因。

#### 延迟：避开推理型号

智谱的 `GLM-4.7-Flash` 是推理模型，实测首字 **53s→240s**（免费池排队，越晚越堵），不适合对话场景。

| 型号 | 实测首字 | 是否免费 | 用途 |
|------|---------|---------|------|
| `glm-4.5-flash` | ~2.7s | ✅ 免费 | 简单文本（默认） |
| `GLM-4.6V-Flash` | ~4.4s | ✅ 免费 | 实测质量不可用，已从默认档位移除 |
| `qwen3.7-flash` | 秒级 | ❌ 付费 | 复杂文本 / 视觉（默认）/ 兜底 |

思考链默认开启（智谱候选一律显式下发 `thinking:{type:'enabled'}`）：客户端要靠它展示「思考 M + 正文 N」的 token 拆分。代价是首字变慢——「你好」这类问候也会先产出上千字推理，追求快首字时配 `CHAT_GLM_THINKING=false`（也接受 `off` / `0` / `no` / `disabled`）关闭。思考内容还需要推理模型，`glm-4-flash` 等非推理型号即使开启也不会产出 `reasoning_content`。实测（`glm-4.5-flash` 流式）上游 usage 只给 `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`，不返回 `completion_tokens_details.reasoning_tokens`，所以 `done.reasoningTokens` 由后端按思考/正文字符占比分摊，是估算值而非上游精确值。

智能问答链路按任务分档给 GLM 下发采样参数（只作用于智谱候选）：闲聊 `temperature=0.7`（比 0.65 基准档更活泼）、知识库/附件问答 `0.4`（严格基于资料、少编造）、实时搜索 `0.5`，`top_p` 统一 `0.8` 以收敛发散、少加空行。代码 Agent 链路和降级到 qwen 的请求不下发，保持服务端默认。`CHAT_GLM_TEMPERATURE` / `CHAT_GLM_TOP_P` 会覆盖所有档位，取值需在 `(0, 1]`，非法值回落到当前档预设。

提示词也按场景分档：工具、附件、知识库来源与引用规则两档共用、始终完整保留，保证 Demo 里工具调用链和来源标注随时可见；本轮没有资料/附件/联网结果/工具需求时，只是额外前置一段「口语直给」的对话风格要求（含 APP 排版规范），让闲聊不显得死板。

#### 面试 Demo 稳定性：离线回放 / 会话保护 / 语音朗读

- **离线回放**：`CHAT_DEMO_REPLAY` 三态。留空（默认）只在主链路（模型、联网检索、数据库）失败时兜底回放；`true` 完全不请求模型，纯离线演示；`off` 关闭。回放按预录顺序重放 `thought` → `tool_call` → `tool_result` → `content` → `sources`，`done.model` 标为 `demo-replay`，现场断网、限流、余额不足都能把流程走完。回放只演示流程，不编造事实、URL 或来源；原始错误仍写后端日志。参数校验这类 400 错误不回放。回放里的结构化工具事件与真实链路一样，会同时双推 `🔧 调用 …` / `↩️ …` 文本 `thought`，老版 APP 纯离线演示时也能看到工具链。
- **固定问题**：`GET /chat/demo/questions` 返回 5 条预置问题（工具调用 / 联网检索 / 知识库 RAG / 多轮追问 / 闲聊身份），演示面板可一键填入。
- **会话保护**：每设备 20 条上限触发自动清理时跳过 24 小时内更新过的会话，避免提前准备的演示历史被静默删掉；跳过时打日志。重置现场用 `DELETE /chat/sessions/:id/messages`，只清空消息、保留会话 ID 与知识库绑定。
- **语音朗读**：`POST /chat/tts` 先把回答里的 Markdown 标题、粗斜体、代码块、链接（只留锚文本）、裸 URL、emoji 与来源标注清洗成口语文本，再按句边界截断到 300 字，避免符号被逐字念出或断在半句。

智谱免费层**限 1 个并发请求**，是 429 的主要来源；本项目已用进程内串行锁规避，并配了限流原地重试。

可用环境变量完全覆盖链路，**无需改代码**：

```bash
# 智谱免费层（不配置则自动退化为单一 qwen 模型，行为与旧版一致）
GLM_API_KEY="智谱开放平台的 API Key"
GLM_BASE_URL="https://open.bigmodel.cn/api/paas/v4"   # 可选

CHAT_MODEL_VISION="qwen3.7-flash"            # 含图片时首选
CHAT_MODEL_TEXT_SIMPLE="glm-4.5-flash"       # 纯文本-简单 首选（免费）
CHAT_MODEL_TEXT_COMPLEX="qwen3.7-flash"      # 纯文本-复杂 首选
CHAT_MODEL_TEXT_EXPERT="qwen3.8-max-0902"    # 纯文本-高难度 首选（顶级模型）
CHAT_MODEL_COMPLEX_FALLBACK="qwen3.7-flash"  # 复杂档兜底，可改 qwen3.7-plus
CHAT_MODEL_FALLBACK="qwen3.7-flash"          # 全局兜底
CHAT_COMPLEXITY_THRESHOLD="3"                # 得分达到该值算「复杂」
CHAT_EXPERT_THRESHOLD="5"                    # 得分达到该值算「高难度」（默认=复杂阈值+2）
CHAT_GLM_THINKING="true"                     # 是否保留思考链（默认开；配 false/off 关闭）
CHAT_GLM_TEMPERATURE=""                      # 留空按任务分档 0.7/0.4/0.5；填值则覆盖所有档位
CHAT_GLM_TOP_P=""                            # 留空用 0.8；填值则覆盖所有档位
CHAT_DEMO_REPLAY=""                          # 留空=失败时兜底回放；true=纯离线演示；off=关闭
CHAT_LIVE_HISTORY_MESSAGES="12"              # 实时查询保留的历史消息条数（6~30，默认 12 ≈ 6 轮）
CHAT_MAX_INPUT_TOKENS="6000"                 # 初始上下文窗口基准；编排器预算 = 该值 + 18000
CHAT_CONTEXT_MAX_INPUT_TOKENS=""             # 留空随上面推导；填值直接覆盖编排器工具循环预算
CHAT_CONTEXT_KEEP_RECENT_TOOLS="3"           # 工具循环里保留最近几条完整工具结果，更早的压成预览
CHAT_CONTEXT_KEEP_RECENT_TOOL_ROUNDS="2"      # 保留最近几轮完整工具调用，更早的整轮压成预览
CHAT_CONTEXT_TOOL_PREVIEW_CHARS="240"        # 旧工具结果压成预览时的长度上限
CHAT_CONTEXT_OLD_MESSAGE_PREVIEW_CHARS="800" # 更早的普通消息压成预览时的长度上限
CHAT_RATE_LIMIT_RETRIES="2"                  # 免费层 429 限流时的原地重试次数
CHAT_MODEL_CONNECT_TIMEOUT_MS="60000"        # 模型连接超时（ms）
CHAT_MODEL_IDLE_TIMEOUT_MS="90000"           # 流式空闲超时（ms）：两个 chunk 之间无数据即中止
CHAT_TOOL_TIMEOUT_MS="120000"                # 单次工具执行超时（ms）
CHAT_TOOL_MAX_RESULT_CHARS="8000"            # 工具结果最大字符数
CHAT_ZHIPU_LOCK_TIMEOUT_MS="5000"            # 智谱串行锁最长等待（ms）；超时自动降级到下一个候选
CHAT_SHOW_ROUTING_THOUGHT="true"             # 是否把模型选择推给前端思考流（含 APP 端）
CHAT_USER_PROFILE="on"                       # 用户画像：on=只记用户明确声明的白名单偏好；off=完全不记不注入
PUBLIC_BASE_URL=""                           # 图片 URL 对外前缀（如 https://api.example.com）；留空用请求 Host
TAVILY_API_KEY=""                            # provider=tavily 时必填；留空则联网检索失败并自动降级
WEB_SEARCH_PROVIDER="tavily"                 # 联网 provider：tavily（默认，境外）| bocha（国内，博查）
BOCHA_API_KEY=""                             # provider=bocha 时必填；见 https://open.bochaai.com
BOCHA_API_URL=""                             # 留空用官方 https://api.bochaai.com/v1/web-search
WEB_SEARCH_TIMEOUT_MS="15000"                # 单次联网超时（1000~60000）
CHAT_SEARCH_SESSION="on"                     # 来源统一回流：on=模型补搜也下发 sources；off=回退旧行为
```

调试时可看日志判断实际走了哪条链路：

```text
🧠 [模型分层] tier=text 复杂度=expert 得分=6（complex>=3，expert>=5）链路=dashscope:qwen3.8-max-0902 → dashscope:qwen3.7-flash | 长输入>200字(+2) 复杂意图:设计/架构(+2)
🧠 [模型分层] tier=text 复杂度=simple 链路=zhipu:glm-4.5-flash → dashscope:qwen3.7-flash
⏱️ [性能监控] 第 1 轮流式耗时: 1181ms，本轮首字 1102ms，工具调用 0 个，模型 dashscope:qwen3.7-flash
```

#### 聊天附件（独立存储，不入知识库）

聊天窗可以直接发**文档**（pdf/doc/docx/txt/md/代码等）和**视频**（mp4/mov/mkv 等）。附件解析后只注入当轮 prompt，**绝不写入向量库、不污染知识库**；原始文件独立落盘保留 30 天，供历史回看与重新提问。

提供两种用法，按前端交互选：

**A. 单步直传（推荐）——文件和消息在同一个请求里**

```http
POST /chat/:id/stream
Content-Type: multipart/form-data

file=<文件>              # 可选
query=这份文档重点是什么？  # 可选，但不能和 file 同时为空
images=["url1"]          # 可选，JSON 字符串或原生数组
fileIds=["kb-id"]        # 可选
attachmentIds=["att-id"] # 可选（A、B 两种模式可混用）
```

解析期间服务端会先推一条 SSE 提示，避免前端干等：
```
data: {"type":"thought","content":"正在解析附件 xxx.pdf…（视频需转写，可能稍久）"}
```
文件类型/大小不合规会在建流前直接返回 **HTTP 400**，不会以 SSE error 形式出现。

**B. 两步：先上传拿 id，再发消息引用**

```http
POST /chat/attachment        # multipart，字段名 file
→ { id, name, kind: "document" | "video", charCount, durationSec? }

POST /chat/:id/stream        # JSON，引用返回的 id
{ "query": "...", "attachmentIds": ["上传返回的 id"] }
```
适合「先预览确认再发送」的交互。id 存在进程内临时存储，**30 分钟后自动过期**。

两种模式共同点：

- 附件文本按 token 预算（默认 4000）截断，从头保留（标题和结论通常在前面）
- **视频（v1）**：ffprobe 校验时长 → 抽音轨转 16k 单声道 wav → 复用 ASR 转写成文字
- 超上限直接拒绝：文件 50MB、视频 10 分钟
- 重复引用同一个 id 只注入一次；id 过期会返回提示让用户重新上传
- `Message.attachments` 只存元数据（name/kind/charCount/durationSec），原文不落库
- 全程不调用 `addDocument`，向量库零写入

> v2 规划：无音轨视频自动切场景抽帧送视觉模型；v3 规划：解析结果可选入 RAG 以支持「视频第几分钟说了什么」这类追问。
> 已知边界：扫描件/图片型 PDF 无 OCR（会提示「没能解析出文字」）。

##### 附件原始文件持久化（支持回看历史）

附件**原始文件会落盘**到 `files/chat-attachments/<uuid>.<ext>`，与知识库 `files/knowledge/` 平级但**完全隔离**（不向量化、不进 RAG），默认保留 **30 天**。这样用户翻聊天记录时还能打开当初发的那份文件。

```http
GET /chat/attachments/:fileRef       # 带登录态读取/预览
```

- **内联预览**（`Content-Disposition: inline`）：pdf、图片、文本/代码、视频
- **下载**（`attachment`）：doc/docx 等其余类型
- 支持 Range（视频可拖进度条）
- `Message.attachments` 元数据带 `fileRef` + `url`，前端历史消息可直接渲染成可点链接：
  ```json
  { "id": "...", "name": "合同.pdf", "kind": "document", "charCount": 3200,
    "fileRef": "a1b2...c5d.pdf", "url": "/chat/attachments/a1b2...c5d.pdf" }
  ```

**顺带解锁的能力：从历史重新提问**。点旧消息里的附件，把它的 `id` 作为 `attachmentIds` 再发一轮即可——内存条目过期后服务端会**从磁盘重新解析**（`附件从磁盘复活` 日志），不用重新上传。

**安全设计**（附件不走静态托管，因为可能含 doc/txt/代码，任意后缀直出有 XSS 风险）：

| 措施 | 说明 |
|------|------|
| 扩展名白名单 | 只允许 30 个已知扩展名；白名单外一律落成 `.bin`（保证可服务也可被清扫，不会变成永久垃圾） |
| **排除 html / svg** | 这两类能以我们自己的 origin 渲染，是存储型 XSS 通道，只给下载 |
| content-type 来自白名单 | 不信任磁盘内容（不做 sniffing） |
| 文件名必须匹配 uuid 正则 | 挡 `../` 穿越、子目录、任意文件名 |
| 下载名统一用 uuid | 不泄露原始文件名（原名已在消息元数据里） |

**清理**：每天扫一次，删除「**未被任何消息引用** + **超过 30 天**」的文件。双条件 AND，正在用的永远不会被删。

```bash
ATTACHMENT_RETAIN_DAYS=30              # 原始文件保留天数
ATTACHMENT_SWEEP_INTERVAL_MS=86400000  # 清扫间隔（默认 24 小时）
```

> 内存里的解析文本仍有 30 分钟 TTL（避免重复解析）；过期后靠磁盘复活，所以**历史回看不受 30 分钟限制**。

#### Excel 错误识别

上传 Excel 直接返回**结构化问题清单**（不落盘、不向量化、不写任何表，独立于知识库和聊天附件）。

```http
POST /chat/excel/check      # multipart，字段名 file
Content-Type: multipart/form-data

→ { fileName, sheets, summary, findings[] }
```

识别两类问题：

**1. 公式错误值**（severity=error）—— Excel 原生的七种错误码，每种都带中文原因和修复建议：

| 错误码 | 含义 | 建议 |
|--------|------|------|
| `#DIV/0!` | 除数为 0 或空 | 用 `IFERROR` 包一层或先判空 |
| `#N/A` | 查找函数没匹配值 | 确认查找值存在；用 `IFNA` 兜底 |
| `#VALUE!` | 参数类型不对 | 检查是否把文本当数字运算 |
| `#REF!` | 引用的单元格被删 | 重新指定被删区域地址 |
| `#NAME?` | 函数名拼错/名称未定义 | 检查拼写、中文引号 |
| `#NULL!` | 区域交集为空 | 逗号改空格取交集，或换 `SUMIFS` |
| `#NUM!` | 数值超范围/不收敛 | 检查参数范围与迭代设置 |

**2. 数据质量**（severity=warning/error）：

| 错误码 | 判定规则 | 级别 |
|--------|---------|------|
| `EMPTY_REQUIRED` | 列空值率 ≤20% 视为必填，报其中的空单元格 | warning |
| `TYPE_MISMATCH` | 列主类型覆盖率 ≥70% 是数字/日期/布尔，其中却有文本 | warning |
| `DUPLICATE_ROW` | 整行内容完全重复（整行空白不判，避免误报） | error |
| `OUTLIER` | 数值超出 `Q1-3*IQR ~ Q3+3*IQR`（样本 <8 个不判） | warning |

返回的每条 finding 都带 `sheet / cell / column / columnName / value / message / suggestion`，前端可直接定位并高亮单元格：

```json
{
  "summary": { "total": 5, "formulaErrors": 1, "dataIssues": 4, "errors": 2, "warnings": 3, "truncated": false },
  "findings": [
    {
      "sheet": "问题表", "cell": "B13", "row": 13, "column": 2, "columnName": "金额",
      "type": "formulaError", "code": "DIV0", "severity": "error",
      "value": "#DIV/0!", "formula": "A1/B20",
      "message": "公式报错 #DIV/0!：除数为 0 或空",
      "suggestion": "用 IFERROR 包一层，或先判空：=IFERROR(A1/B1,\"\")"
    }
  ]
}
```

可用 `rules` 字段（JSON 字符串）按需开关与调参，例如只看公式错误：

```
rules: {"formulaErrors": true, "emptyRequired": false, "typeMismatch": false, "duplicateRow": false, "outlier": false}
rules: {"ignoreColumns": ["备注"], "requiredEmptyThreshold": 0.1, "outlierIqrMultiplier": 2}
```

保护性上限：单表最多扫 2 万行、最多返回 300 条（超出 `summary.truncated=true`）、总单元格数 30 万（超过直接拒绝并提示）。`.xlsx`/`.xls` 之外的类型返回 400；文件加密或损坏也会给出明确提示。

> 已知边界：扫描件/图片型 PDF 无 OCR；`.xls`（老二进制格式）由 exceljs 解析，遇到极端老版本可能失败；公式的识别依赖 Excel 保存的缓存计算结果，若文件从未打开计算过，公式错误可能查不出来。

#### 图片上传与清理

聊天图片走「选中即上传」：前端选完图立刻 `POST /chat/upload-image`，拿到服务端 URL 后再随消息发出。

```http
POST /chat/upload-image
{ "image": "data:image/png;base64,...." }
→ { "url": "/uploads/img-<时间戳>-<uuid>.png" }
```

**选了但不发**会产生孤儿文件，服务端提供两种回收途径：

```http
DELETE /chat/uploads/:filename      # 删图片 chip / 清空已选时调用
→ 204 成功 / 404 不存在 / 409 已被消息引用 / 400 非法文件名
```

- filename 必须匹配 `img-<ts>-<uuid>.<png|jpg|jpeg|gif|webp|bmp|avif>` 规则，否则 400（顺带挡住 `../` 穿越和子目录）
- 被任何消息 `images[]` 引用的文件一律拒删（409）——宁可留孤儿，也不能让历史回显坏掉
- 前端只应在「预传了但没发送」时调用；已发送的图由消息引用保护，不用管

**服务端兜底清扫**：默认每 30 分钟扫一次 `uploads/`，删除满足两个条件的文件——**未被任何消息引用** + **存留超过 60 分钟**。覆盖「传了、不发、也没点 X」的场景。只碰自己生成的 `img-*` 文件，其它文件一律不动。

可用环境变量调整：

```bash
UPLOADS_SWEEP_ENABLED=false          # 关掉定时清扫
UPLOADS_SWEEP_INTERVAL_MS=1800000    # 清扫间隔（默认 30 分钟）
UPLOADS_ORPHAN_MIN_AGE_MIN=60        # 存留多久才算孤儿（默认 60 分钟）
```

> 附件（文档/视频）不需要删除接口：解析结果只存内存，30 分钟 TTL + 每 5 分钟 sweep 自动回收，不落盘也不入向量库。

#### 知识库文档检索开关
查看知识库文件时，`GET /chat/knowledge/files` 会返回每个文件的 `enabled` 状态。使用下面的接口单独切换文件是否参与检索：

```http
PUT /chat/knowledge/files/{id}/enabled
Content-Type: application/json

{"enabled": false}
```

`enabled` 必须是布尔值；新上传的文件默认启用。修改 Prisma schema 后，若数据库尚未包含所需字段，请运行 `pnpm --filter @repo/server exec prisma db push` 同步数据库结构。

聊天回答会记录本轮实际引用的知识库文件。`GET /chat/sessions/{id}` 返回的消息包含 `sources`：每个来源保留文件 ID 和回答时的文件名，并提供当前 `currentlyEnabled` 与 `currentStatus`。删除或停用文档不会改写旧回答；后续追问时，模型会区分历史回答与本轮检索资料，并提示来源当前已停用、已删除或未能重新核实。流式聊天完成时还会发送 `type: "sources"` 事件，`sources` 数组包含本轮引用来源。

在此功能上线前生成的旧消息没有来源快照，`sources` 仍为 `null`；其原始来源无法从历史文本中可靠恢复，因此会标注为来源未记录，而不会猜测。

### 测试分层

测试分三层，命令不同，目的也不同：

| 命令 | 范围 | 依赖 | 用途 |
|------|------|------|------|
| `pnpm --filter @repo/server test` | `src/**/*.spec.ts` 的**纯函数单测** | 无（全 mock，不连库不连外部 API） | 提交前必跑，要求始终全绿 |
| `pnpm --filter @repo/server test:integration` | `test/integration/*.integration.spec.ts` | 真实 PostgreSQL / 真实文件格式 | 改了向量检索、Excel 解析这类底层逻辑后手动跑 |
| `pnpm --filter @repo/server test:e2e` | `test/**/*.e2e-spec.ts` | 完整应用 + 真实外部服务 | 端到端流程验证 |
| `pnpm --filter @repo/server test:all` | 前两个一起跑 | — | 本地全量回归 |

> 共享编排器的测试在 `packages/agent-orchestrator`：`pnpm --filter @repo/agent-orchestrator test`。
> 仓库根目录直接 `pnpm test` 会用 turbo 跑所有包的测试。

> `vitest.config.ts` 的 `exclude` 已把 `*.integration.spec.ts` 从默认运行里剔除，
> 所以即便本地没有配置数据库，单测也不会再出现红色文件。

#### 各 spec 覆盖什么

| 文件 | 层 | 覆盖 |
|------|----|------|
| `src/chat/excel-check.spec.ts` | 单元 | Excel 错误识别的纯规则：单元格归一化、列地址换算、列类型推断、必填判定、IQR 离群、行指纹、错误码元数据 |
| `test/integration/excel-check.integration.spec.ts` | 集成 | 用 exceljs 写真实 xlsx 跑全流程：五类问题各一例 + 上限截断、规则开关、空行误报、多工作表 |
| `packages/agent-orchestrator/src/model-cascade.spec.ts` | 单元 | 模型分层：复杂度判定、平台推导（glm/qwen）、候选链、降级判定、配置与思考开关、采样三档与 env 覆盖 |
| `packages/agent-orchestrator/src/orchestrator.spec.ts` | 单元 | 编排器主循环：纯对话、工具调用回填、拒答重试、候选降级、无候选、中断、锁等待超时降级、采样只下发智谱候选 |
| `packages/agent-orchestrator/src/simple-lock.spec.ts` | 单元 | 进程内互斥锁：互斥性、FIFO、重复释放保护、异常必须 finally |
| `packages/agent-orchestrator/src/tool-call-accumulator.spec.ts` | 单元 | 流式 tool_calls 分片累积与收敛 |
| `src/agents/agents.spec.ts` | 单元 | agent 注册、消息组装、工具执行、editor 文件工具越界/破坏性命令防护 |
| `src/chat/attachment-store.spec.ts` | 单元 | 附件临时存储：TTL 边界、批量取、重复 id 去重、清扫 |
| `src/chat/document-text.spec.ts` | 单元 | 文档/视频扩展名互斥、UTF-8 直读、NUL 剥离、mimetype 兜底 |
| `src/chat/video-transcript.spec.ts` | 单元 | 视频超时长 / 无音轨错误类型与文案 |
| `src/auth/auth.service.spec.ts` | 单元 | 设备/管理员登录、token 校验、每日配额与跨天重置、用量记账 |
| `src/auth/admin.controller.spec.ts` | 单元 | 管理后台：非管理员 403、设备分页、用量统计 |
| `src/chat/chat.service.spec.ts` | 单元 | 会话 CRUD 契约（不存在返回 null、标题更新、删除）、演示会话 24h 保护与清空消息 |
| `src/chat/chat-prompt.spec.ts` | 单元 | APP 端提示词与排版清洗、两档共用完整工具/引用规则、滚动摘要与附件要点、模板注入、错误收敛、朗读文本清洗 |
| `src/chat/user-profile.spec.ts` | 单元 | 用户画像：显式声明才记、四类白名单、否定句不记、同类型覆盖、脏数据丢弃 |
| `src/chat/chat.controller.spec.ts` | 单元 | SSE 事件透传、done 指标、错误帧、演示辅助接口 |
| `src/chat/demo-replay.spec.ts` | 单元 | 回放三态、预录事件与不编造兜底，forced / 失败兜底 / off 的服务集成；RAG 追问缓存、预算同源与记忆指标 |
| `src/chat/kb-upload.spec.ts` | 单元 | 知识库上传：类型/大小拒绝、状态流转、删除（mock Prisma） |
| `src/chat/web-search.spec.ts` | 单元 | 实时查询识别、Tavily 结果格式化 |
| `src/vector/vector.service.spec.ts` | 单元 | 向量写入 NUL 清洗、metadata 删除过滤 |
| `test/integration/vector-search.integration.spec.ts` | 集成 | **真实 DB**：插入切片 → 按 fileId 检索 → `enabled` 开关过滤（无 `DATABASE_URL` 自动 skip） |



```bash
pnpm --filter @repo/server build
pnpm --filter @repo/server start:dev
pnpm --filter @repo/server test
pnpm --filter @repo/server lint
```

---

## apps/editor-desktop — Editor Desktop

> Cursor 式代码助手 demo：Electron + React，支持本地 / 云端双模式，两种模式都编辑本地项目。

Cursor 式代码助手 demo：Electron + React，支持 **本地 / 云端** 双模式。

| 模式 | agent 循环在哪跑 | 工具在哪执行 | 编辑的文件 | 模型 |
|------|-----------------|--------------|------------|------|
| 本地 | Electron 主进程 | Electron 主进程 | 用户打开的本地项目 | 客户端配置的 key |
| 云端 | NestJS 后端 | **客户端本地**（后端通过 `tool_request` 委托） | 用户打开的本地项目 | 后端 key |

两种模式都编辑本地项目，区别只是「编排器跑在哪」。

顶栏可随时切换，模式会持久化到 `localStorage`；切换时会中止当前流并重置会话。

### 开发

```bash
# 仓库根目录安装依赖
pnpm install

# 启动（会自动拉起 Vite dev server + Electron）
pnpm --filter @repo/editor-desktop dev
```

#### 本地模式配置

**API Key 从环境变量读取，不写进配置文件。**

在 `apps/editor-desktop/.env` 里配置（复制 `.env.example`）：

```bash
GLM_API_KEY=xxx          # 智谱（默认免费模型 glm-4.5-flash）
OPENAI_API_KEY=xxx       # 通义千问 / 其它 OpenAI 兼容
```

也可以在启动 Electron 前直接设置环境变量；修改 `.env` 后需重启应用。

默认只显示**一个免费模型** `glm-4.5-flash`；更多模型/提供商在「设置 → 提供商」里添加
（参考 Cursor / Cherry Studio 的自定义提供商表单）：

- 提供商 ID、显示名称、基础 URL
- **Provider API 预设**：OpenAI / OpenAI Compatible / DeepSeek / Moonshot (Kimi) /
  通义千问 / 智谱 GLM / Ollama（本地，免 key）/ OpenRouter / Groq / Mistral /
  xAI (Grok) / SiliconFlow / Azure OpenAI；选中后自动填 Base URL、Key 环境变量、
  默认模型
- **API Key 环境变量**（例如 `GLM_API_KEY`）
- 模型列表：ID / 名称 / 推理 / 图片，支持「获取模型」从 `/models` 拉取

默认提供商：

| 提供商 | Key 环境变量 | 默认模型 |
|--------|--------------|----------|
| 智谱 GLM（免费） | `GLM_API_KEY` | `glm-4.5-flash` |

**只有配置了 key 的提供商，其模型才会出现在顶栏模型下拉里**；一个 key 都没配时
会提示「没有可用模型」。顶栏模型下拉本地/云端都能切换：本地直接换模型，云端把
模型名透传给后端。

> 默认只内置免费 `glm-4.5-flash`；**不预置通义/付费模型**。需要更强的模型请自行
> 添加提供商。云端模式也会显式带上选中的模型，不会落到后端的付费级联。

首次启动**不预置任何工作区**（文件树为空）；点「打开文件夹」选择项目后，
文件树和 AI 读写都会作用于该目录，并记住下次启动恢复。

#### 云端模式

后端地址写死在 `src/renderer/src/cloud.ts` 的 `CLOUD_BACKEND_URL`，部署时改这里即可。
顶栏切到「云端」后：

1. `POST /auth/anonymous-login` 拿 token；
2. 后端跑编排器（`/agent/editor/session/:id/stream` SSE）；
3. 需要调工具时，后端下发 `tool_request`，客户端在**本地**执行后
   `POST /agent/editor/session/:id/tool-result` 回传结果。

所以云端模式改的仍是本地项目，模型用后端的 key；模型可在顶栏下拉切换，
默认带 `glm-4.5-flash`，不会落到后端的付费级联。

### 构建与校验

```bash
pnpm --filter @repo/editor-desktop build      # electron-vite build
pnpm --filter @repo/editor-desktop typecheck  # node + web 两套 tsconfig
```

产物在 `out/`：

- `out/main/index.js`（ESM）
- `out/preload/index.mjs`（`"type": "module"` 下 electron-vite 产出 ESM 预加载）
- `out/renderer/`（Vite 打包的静态资源）

> 主进程按 `.mjs` 指向预加载脚本，并关闭了 `sandbox`（ESM preload 需要）。

### 架构

```
renderer
  ├── ModeContext              # local | remote，持久化
  ├── AgentTransport           # LocalTransport(IPC) / RemoteTransport(SSE + tool RPC)
  └── WorkspaceProvider        # LocalWorkspace(IPC)，两种模式共用

main
  ├── LocalAgent               # AgentOrchestrator + createEditorAgent(openedFolder)
  ├── ipc                      # agent:run/event/abort/execTool + workspace:*
  └── model                    # OpenAI 兼容客户端（本地模式）

backend（云端模式）
  ├── AgentOrchestrator        # 跑循环，工具 handler 换成 proxy
  ├── PendingToolService       # 等待客户端 tool-result 的 resolver
  └── POST .../tool-result     # 客户端回传工具结果
```

编辑器工具在共享包 `packages/editor-agent`，通过 `createEditorTools(root)` 注入工作区根目录：
后端用 `AGENT_WORKSPACE_ROOT`，桌面用用户打开的文件夹，**同一份实现**。

### 内置工具

`read_file` / `write_file` / `edit_file` / `apply_patch` / `delete_file` / `move_file` /
`create_directory` / `list_dir` / `search_files` / `glob` / `run_terminal` /
`git_status` / `git_diff`

### 功能

- 左侧工作区文件树（本地 IPC），支持**多个文件夹**（VS Code 多根），目录可展开/折叠
- 可添加/移除文件夹、清空工作区
- 文件树右键菜单：新建文件/文件夹、重命名、删除、问 AI
- 中间代码编辑器：CodeMirror + oneDark，按扩展名语法高亮，**可手动编辑 + Ctrl+S 保存**
- 底部终端面板：在工作区目录执行命令，支持 `cd` / `clear`
- 快速打开文件（Ctrl+P）、侧栏开关（Ctrl+B）、设置（Ctrl+,）
- 右侧 AI 对话，流式渲染 `thought` / `content` / `tool_call` / `tool_result`
- 输入框支持 `@` 引用工作区文件，发送时自动把文件内容带给 agent
- 每轮结束后在侧栏列出「本轮改动」，点击查看行级 diff（A/M/D/R 标记）
- 生成中可「停止」，会 abort 上游请求

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+S` | 保存当前文件 |
| `` Ctrl+` `` | 显示 / 隐藏终端 |
| `Ctrl+B` | 显示 / 隐藏侧栏 |
| `Ctrl+P` | 快速打开文件 |
| `Ctrl+,` | 打开设置 |
| `Esc` | 关闭弹窗 |

### 应用图标

| 位置 | 作用 |
|------|------|
| `resources/icon.ico` / `resources/icon.png` | 开发/运行时的窗口与任务栏图标（`BrowserWindow.icon` 自动读取，Windows 建议 `.ico`） |
| `build/icon.ico` / `build/icon.icns` / `build/icon.png` | 打包后的应用图标（electron-builder 的 `build.icon`） |
| `src/renderer/index.html` 的 `<link rel="icon">` | 页面 favicon（只影响浏览器标签，不影响 Electron 窗口） |
| `src/main/index.ts` 的 `title` + `index.html` 的 `<title>` | 窗口标题（当前 `DieTai Editor Desktop`） |

把图标放到 `resources/` 下（`icon.ico` 优先，其次 `icon.png`），重启 Electron 即可。

### 安全说明

- 所有文件工具都限制在工作区根目录内，越界路径直接拒绝。
- `run_terminal` 有破坏性命令黑名单；`delete_file` 只能删文件。
- 模型 API Key 存在 Electron `userData/config.json`，`safeStorage` 可用时用系统钥匙串加密。
- 本地模式支持「工具直接写入」与「diff 块审批」两种：文件操作审批开启时，AI 改动先不落盘，消息里显示「待确认」，确认后才写入；也可在 diff 视图逐块接受/拒绝。

---

## packages — 共享包

| 包 | 职责 |
|----|------|
| `agent-orchestrator` | 模型级联、降级、流式 `tool_calls` 累积、工具循环、上下文治理、断点续跑状态机 |
| `editor-agent` | `createEditorTools(root)` 工厂：文件读写/搜索/glob/终端/git/`verify_workspace`/`read_artifact` |
| `general-agent` | `createGeneralTools` / `createChatTools` + prompt + `festival_info`（含剩余天数计算） |
| `agent-types` | 跨仓库 SSE 事件 / 工具契约类型 |

## 部署

Docker 构建上下文是仓库根（要拿到 `packages/`）：

```bash
# 构建（compose 里已定义 build: .；服务器没装 buildx 时用这个）
docker compose -f docker-compose.4001.yml --env-file apps/server/.env build backend

# 启动：postgres → 一次性 db-push（同步表结构）→ backend
docker compose -f docker-compose.4001.yml --env-file apps/server/.env up -d --no-build
```

> 内存紧张且**装了 buildx** 的机器可以限内存构建：`docker buildx build --memory 1500m -t my-backend-app:latest .`。
> 没装 buildx 时执行它会报 `unknown flag: --memory`（buildx 的参数被当成 docker 的），构建仍会退回 compose 的 docker driver 继续跑。

> 注意：`.env` 位于 `apps/server/.env`，不是仓库根。

### 表结构怎么同步的

项目**没有 migrations**，只有 `prisma db push`。compose 里为此加了一个一次性服务 `db-push`：跑完即退出，`backend` 等它 `service_completed_successfully` 才启动，所以不会再出现「服务起来了但 Prisma 报列不存在」。

- `prisma` 是 `@repo/server` 的**运行时依赖**（不是 devDependency），所以生产镜像里自带 CLI：`/app/apps/server/node_modules/prisma`。compose 的 `db-push` 服务直接用 `node /app/apps/server/node_modules/prisma/build/index.js db push` 执行；Dockerfile 第 8 步会在构建期断言这个入口真的能跑（`prisma -v`），缺了就地构建失败，不会等到上线才发现。
- 镜像里另外保留了两份「装依赖时 postinstall 下载的二进制」：`schema-engine`（Prisma 的 DDL 引擎）和 `ffmpeg`（视频转写 / TTS / 图片处理要用）。prod 安装带 `--ignore-scripts` 会跳过 postinstall，所以 Dockerfile 第 6.5 步先存、第 7.2 步再补回依赖树。
- **改了 `schema.prisma` 之后**：`db-push` 是「跑一次就退出」的一次性任务，单纯再 `up` 不会重跑它，二选一：

```bash
# 方式一：只重跑表结构同步
docker compose -f docker-compose.4001.yml --env-file apps/server/.env run --rm db-push

# 方式二：重建所有容器（会顺带重启 backend）
docker compose -f docker-compose.4001.yml --env-file apps/server/.env up -d --no-build --force-recreate
```

- **本地开发**不走 compose：在仓库根跑 `pnpm --filter @repo/server exec prisma db push`，直连 `apps/server/.env` 里的 DATABASE_URL。
- ⚠️ 端口坑：compose 把 postgres 映射成宿主 `5433:5432`，容器内必须用服务名 `postgres:5432`；`db-push` 的 DATABASE_URL 由 compose 用 `DB_USER` / `DB_PASSWORD` / `DB_NAME` 现场拼，不依赖 `.env` 里那个 `localhost` 地址。

### 聊天图片与附件的持久化

图片走 `POST /chat/upload-image`（base64 → 落盘 → 返回绝对 URL），URL 存进 `Message.images Json?`；聊天附件（docx / txt / pdf）落在 `files/chat-attachments/`。两者都写在**容器可写层**，所以 compose 给 `backend` 挂了两个命名卷：

```yaml
volumes:
  - uploads:/app/apps/server/uploads
  - chat-files:/app/apps/server/files
```

⚠️ 不挂卷时每次部署 `Recreate` backend 容器，文件随可写层一起没了，但 postgres 卷里的 `Message.images` 还在 → 历史消息返回 URL、图片 404，表现就是「聊天记录的图片不回显」。卷是具名的，`docker compose down` 不会删，只有 `down -v` 才会清掉。

判断「服务端还是客户端」的最小验证（在服务器上）：

```bash
# 1) 历史接口里有没有图片字段
curl -H "Authorization: Bearer <token>" http://127.0.0.1:4001/chat/sessions/<sessionId> | jq '.messages[] | select(.images) | .images'
# 2) 上一步返回的 URL 能不能取到图片
curl -I "<url>"
```

- 第 1 步有 `images`、第 2 步 404 → **服务端**文件没了（旧镜像部署时容器重建丢的，或卷没挂上）。重新上传即可；已经丢的文件救不回来。
- 第 1 步有 `images`、第 2 步 200 → 服务端没问题，是**客户端**没读 `images` 字段，或图片被拦（HTTPS 页面加载 http 图片属于混合内容）。
- 第 1 步没有 `images` → 上传时字段名没对上：请求体必须是 `images: [url]`。只传单数 `image` 且是 base64 现在会明确 400（旧版会静默忽略，当轮本地预览还在、刷新就没了）。

`PUBLIC_BASE_URL`（可选）：部署在 Nginx / HTTPS 后面时配成公网地址（如 `https://api.example.com`），图片 URL 固定用它，不再依赖请求 Host，避免落库的是内网地址或 http 导致手机端加载失败。

### 2 核 2G 小机器建议

- **构建是 CPU 密集型**：`pnpm install` + `tsc` + `prisma generate` 会跑满 2 核。如果部署时机器卡死，建议在 CI（ubuntu-latest）里构建并推送到镜像仓库，ECS 只 `docker pull`。
- **Prisma 的 OpenSSL 告警**：构建时会出现 `Prisma failed to detect the libssl/openssl version ... Defaulting to "openssl-1.1.x"`。`node:24-slim` 里 node 自带 libssl3，Prisma 7 的 schema diff 走 WASM（`@prisma/prisma-schema-wasm`），引擎实际可用（`prisma db push` 已在生产验证跑通），这个告警无害；真报引擎错误时再在 Dockerfile 里加 `apt-get install -y --no-install-recommends openssl`（国内 apt 源慢，会拖构建，所以默认不加）。
- **Node 版本**：基础镜像用 `node:24-slim`（Node 20 已于 2026-04 结束维护，不再有安全更新）。依赖都已声明支持 24：`@prisma/client` 7.10（`^20.19 || ^22.12 || >=24.0`）、`@nestjs/core` 12（`>=20`）、`vitest` 4（`^20 || ^22 || >=24`）。CI 里**没有 `setup-node`**（workflow 只做 checkout + SSH，Node 全在服务器/镜像里），所以不存在「CI 与镜像版本要一致」的问题。
- **镜像里的 pnpm 固定在 9**：pnpm 10 默认屏蔽所有 postinstall，要靠仓库根 `.npmrc` 的 `only-built-dependencies` 白名单放行，而 `.npmrc` 没有 COPY 进镜像 → `@prisma/engines` / `ffmpeg-static` 的二进制不会下载（`/opt/bin-assets` 会是空的，prod 树里也就没有 ffmpeg）。要升 pnpm 10，必须同时把 `.npmrc` 复制进镜像。
- **运行时资源已在 compose 里限制**：postgres `0.8 核 / 512M`，backend `1.2 核 / 768M`，Node 堆 `--max-old-space-size=512`，postgres 参数已调小。
- **加 swap**：`fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`，避免内存尖峰直接触发 OOM。
- **监控**：`docker stats` / `htop` 看是构建还是运行时吃 CPU；`docker logs -f ai-agent-backend` 看是否崩溃重启。

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
- [x] 消息下方展示「耗时 · tokens」（服务端推 `done` 事件）
- [x] diff 逐段接受/拒绝（并排对比 + hunk 选择）
- [x] 本地模式的会话历史持久化（`chat-sessions.json`，多任务标签）
- [x] 内置浏览器预览（WebContentsView，仅 localhost）+ AI 一键打开
- [x] 多终端（实时输出、历史命令、停止、链接点击、多 profile）
- [x] 工具审批拆分（命令执行 / 文件操作）+ diff 块审批
- [x] 空响应自动追问 / 多轮工具循环上限提升

## 包管理器

统一使用 pnpm（workspace）。不要混用 npm / yarn，也不要提交 `package-lock.json`。
