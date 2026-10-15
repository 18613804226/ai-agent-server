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
- 知识库文件可单独启用或禁用；禁用后文件和向量切片保留，但不会参与任何向量检索。
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

## 模型分层与级联调度

单模型方案下，简单问答和复杂请求付同样的钱。本项目按 **Model Cascade（FrugalGPT）** 思路做了两层优化：

1. **成本分层**：免费层（智谱 GLM 免费额度）前置承载大部分请求，付费层（DashScope qwen）只做兜底。
2. **多通道降级**：主模型请求失败（限流、5xx、模型不存在）时自动切换到候选链上的下一个模型，仅重试建连阶段，不重试已吐字的中途失败，避免给客户端推送重复内容。
3. **免费层并发串行**：智谱免费层只允许 1 个并发请求，多用户同时发消息会直接触发 429。进程内用一把全局锁把智谱请求串起来（锁持有到整条流读完），qwen 付费层不受影响。若仍偶发限流，还会原地退避重试 2 次再降级。

请求按以下规则分流：

```text
含图片/视频？
  ├─ 是 → qwen3.7-flash（全模态，付费）
  └─ 否（纯文本）→ 按规则判定复杂度，三级分流：
        简单(得分<3)  → glm-4-flash（免费）→ qwen3.7-flash 兜底
        复杂(3~4)    → qwen3.7-flash
        高难度(>=5)  → qwen3.8-max → qwen3.7-flash 退路
```

阿里云侧所有模型（`qwen3.7-flash` / `qwen3.7-plus` / `qwen3.8-max`）共用同一套 `OPENAI_API_KEY` + `OPENAI_BASE_URL`，**无需额外配置**，只是模型名不同。

复杂度用**纯规则**判定（输入长度、是否多问题、代码/计算/结构化输出特征、实时信息查询等），命中项会写进日志的 `[模型分层]` 行，便于回头调整阈值。规则不引入额外模型调用，零开销。

### 为什么视觉和复杂文本不用 GLM 免费款

| 型号 | 实测问题 | 结论 |
|------|---------|------|
| `GLM-4.7-Flash` | 高峰期首字 53s→240s（免费池排队） | 不可用 |
| `GLM-4.6V-Flash` | 指令遵循弱，会把图片问题胡编成不存在的工具调用（如 `fetchImageContent`） | 质量不可用 |
| `glm-4-flash` | 快（2.7s）、回答稳 | ✅ 简单文本默认档 |

级联降级只对**报错**生效（限流、5xx、模型不存在），对「回答质量差但返回 200」无能为力。所以质量不达标的模型不能靠降级兜底，只能从默认档位里排除——这也是视觉档直接选 qwen 的原因。

### 延迟：避开推理型号

智谱的 `GLM-4.7-Flash` 是推理模型，实测首字 **53s→240s**（免费池排队，越晚越堵），不适合对话场景。

| 型号 | 实测首字 | 是否免费 | 用途 |
|------|---------|---------|------|
| `glm-4-flash` | ~2.7s | ✅ 免费 | 简单文本（默认） |
| `GLM-4.6V-Flash` | ~4.4s | ✅ 免费 | 实测质量不可用，已从默认档位移除 |
| `qwen3.7-flash` | 秒级 | ❌ 付费 | 复杂文本 / 视觉（默认）/ 兜底 |

思考链默认给智谱请求带上 `thinking:{type:'disabled'}`：它会让「你好」这种问候也产出上千字推理，严重拖慢首字。需要模型自行深度推理时配 `CHAT_GLM_THINKING=true`（且必须换成 `GLM-4.6V-Flash` 等推理模型，`glm-4-flash` 无推理能力）。

智谱免费层**限 1 个并发请求**，是 429 的主要来源；本项目已用进程内串行锁规避，并配了限流原地重试。

可用环境变量完全覆盖链路，**无需改代码**：

```bash
# 智谱免费层（不配置则自动退化为单一 qwen 模型，行为与旧版一致）
GLM_API_KEY="智谱开放平台的 API Key"
GLM_BASE_URL="https://open.bigmodel.cn/api/paas/v4"   # 可选

CHAT_MODEL_VISION="qwen3.7-flash"            # 含图片时首选
CHAT_MODEL_TEXT_SIMPLE="glm-4-flash"         # 纯文本-简单 首选（免费）
CHAT_MODEL_TEXT_COMPLEX="qwen3.7-flash"      # 纯文本-复杂 首选
CHAT_MODEL_TEXT_EXPERT="qwen3.8-max"         # 纯文本-高难度 首选（顶级模型）
CHAT_MODEL_COMPLEX_FALLBACK="qwen3.7-flash"  # 复杂档兜底，可改 qwen3.7-plus
CHAT_MODEL_FALLBACK="qwen3.7-flash"          # 全局兜底
CHAT_COMPLEXITY_THRESHOLD="3"                # 得分达到该值算「复杂」
CHAT_EXPERT_THRESHOLD="5"                    # 得分达到该值算「高难度」（默认=复杂阈值+2）
CHAT_GLM_THINKING="false"                    # 是否保留思考链（默认关）
CHAT_RATE_LIMIT_RETRIES="2"                  # 免费层 429 限流时的原地重试次数
CHAT_SHOW_ROUTING_THOUGHT="true"             # 是否把模型选择推给前端思考流
```

调试时可看日志判断实际走了哪条链路：

```text
🧠 [模型分层] tier=text 复杂度=expert 得分=6（complex>=3，expert>=5）链路=dashscope:qwen3.8-max → dashscope:qwen3.7-flash | 长输入>200字(+2) 复杂意图:设计/架构(+2)
🧠 [模型分层] tier=text 复杂度=simple 链路=zhipu:glm-4-flash → dashscope:qwen3.7-flash
⏱️ [性能监控] 第 1 轮流式耗时: 1181ms，本轮首字 1102ms，工具调用 0 个，模型 dashscope:qwen3.7-flash
```

### 聊天附件（独立存储，不入知识库）

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

#### 附件原始文件持久化（支持回看历史）

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

### Excel 错误识别

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

### 图片上传与清理

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

### 知识库文档检索开关
查看知识库文件时，`GET /chat/knowledge/files` 会返回每个文件的 `enabled` 状态。使用下面的接口单独切换文件是否参与检索：

```http
PUT /chat/knowledge/files/{id}/enabled
Content-Type: application/json

{"enabled": false}
```

`enabled` 必须是布尔值；新上传的文件默认启用。修改 Prisma schema 后，若数据库尚未包含所需字段，请运行 `npx prisma db push` 同步数据库结构。

聊天回答会记录本轮实际引用的知识库文件。`GET /chat/sessions/{id}` 返回的消息包含 `sources`：每个来源保留文件 ID 和回答时的文件名，并提供当前 `currentlyEnabled` 与 `currentStatus`。删除或停用文档不会改写旧回答；后续追问时，模型会区分历史回答与本轮检索资料，并提示来源当前已停用、已删除或未能重新核实。流式聊天完成时还会发送 `type: "sources"` 事件，`sources` 数组包含本轮引用来源。

在此功能上线前生成的旧消息没有来源快照，`sources` 仍为 `null`；其原始来源无法从历史文本中可靠恢复，因此会标注为来源未记录，而不会猜测。

## 测试分层

测试分三层，命令不同，目的也不同：

| 命令 | 范围 | 依赖 | 用途 |
|------|------|------|------|
| `npm test` | `src/**/*.spec.ts` 的**纯函数单测** | 无（全 mock，不连库不连外部 API） | 提交前必跑，要求始终全绿 |
| `npm run test:integration` | `test/integration/*.integration.spec.ts` | 真实 PostgreSQL / 真实文件格式 | 改了向量检索、Excel 解析这类底层逻辑后手动跑 |
| `npm run test:e2e` | `test/**/*.e2e-spec.ts` | 完整应用 + 真实外部服务 | 端到端流程验证 |
| `npm run test:all` | 前两个一起跑 | — | 本地全量回归 |

> `vitest.config.ts` 的 `exclude` 已把 `*.integration.spec.ts` 从默认运行里剔除，
> 所以即便本地没有配置数据库，`npm test` 也不会再出现红色文件。

### 各 spec 覆盖什么

| 文件 | 层 | 覆盖 |
|------|----|------|
| `src/chat/excel-check.spec.ts` | 单元 | Excel 错误识别的纯规则：单元格归一化、列地址换算、列类型推断、必填判定、IQR 离群、行指纹、错误码元数据 |
| `test/integration/excel-check.integration.spec.ts` | 集成 | 用 exceljs 写真实 xlsx 跑全流程：五类问题各一例 + 上限截断、规则开关、空行误报、多工作表 |
| `src/chat/model-cascade.spec.ts` | 单元 | 模型分层：复杂度判定、平台推导（glm/qwen）、候选链、降级判定、配置与思考开关 |
| `src/chat/attachment-store.spec.ts` | 单元 | 附件临时存储：TTL 边界、批量取、重复 id 去重、清扫 |
| `src/chat/document-text.spec.ts` | 单元 | 文档/视频扩展名互斥、UTF-8 直读、NUL 剥离、mimetype 兜底 |
| `src/chat/video-transcript.spec.ts` | 单元 | 视频超时长 / 无音轨错误类型与文案 |
| `src/chat/simple-lock.spec.ts` | 单元 | 进程内互斥锁：互斥性、FIFO、重复释放保护、异常必须 finally |
| `src/auth/auth.service.spec.ts` | 单元 | 设备/管理员登录、token 校验、每日配额与跨天重置、用量记账 |
| `src/auth/admin.controller.spec.ts` | 单元 | 管理后台：非管理员 403、设备分页、用量统计 |
| `src/chat/chat.service.spec.ts` | 单元 | 会话 CRUD 契约（不存在返回 null、标题更新、删除） |
| `src/chat/kb-upload.spec.ts` | 单元 | 知识库上传：类型/大小拒绝、状态流转、删除（mock Prisma） |
| `src/chat/tool-call-accumulator.spec.ts` | 单元 | 流式 tool_calls 分片累积与收敛 |
| `src/chat/web-search.spec.ts` | 单元 | 实时查询识别、Tavily 结果格式化 |
| `src/vector/vector.service.spec.ts` | 单元 | 向量写入 NUL 清洗、metadata 删除过滤 |
| `test/integration/vector-search.integration.spec.ts` | 集成 | **真实 DB**：插入切片 → 按 fileId 检索 → `enabled` 开关过滤（无 `DATABASE_URL` 自动 skip） |



```bash
npm run build
npm run start:dev
npm test
npm run lint
```
