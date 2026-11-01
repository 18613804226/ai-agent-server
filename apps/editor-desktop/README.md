# Editor Desktop

Cursor 式代码助手 demo：Electron + React，支持 **本地 / 云端** 双模式。

| 模式 | agent 循环在哪跑 | 工具在哪执行 | 编辑的文件 | 模型 |
|------|-----------------|--------------|------------|------|
| 本地 | Electron 主进程 | Electron 主进程 | 用户打开的本地项目 | 客户端配置的 key |
| 云端 | NestJS 后端 | **客户端本地**（后端通过 `tool_request` 委托） | 用户打开的本地项目 | 后端 key |

两种模式都编辑本地项目，区别只是「编排器跑在哪」。

顶栏可随时切换，模式会持久化到 `localStorage`；切换时会中止当前流并重置会话。

## 开发

```bash
# 仓库根目录安装依赖
pnpm install

# 启动（会自动拉起 Vite dev server + Electron）
pnpm --filter @repo/editor-desktop dev
```

### 本地模式配置

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

### 云端模式

后端地址写死在 `src/renderer/src/cloud.ts` 的 `CLOUD_BACKEND_URL`，部署时改这里即可。
顶栏切到「云端」后：

1. `POST /auth/anonymous-login` 拿 token；
2. 后端跑编排器（`/agent/editor/session/:id/stream` SSE）；
3. 需要调工具时，后端下发 `tool_request`，客户端在**本地**执行后
   `POST /agent/editor/session/:id/tool-result` 回传结果。

所以云端模式改的仍是本地项目，模型用后端的 key；模型可在顶栏下拉切换，
默认带 `glm-4.5-flash`，不会落到后端的付费级联。

## 构建与校验

```bash
pnpm --filter @repo/editor-desktop build      # electron-vite build
pnpm --filter @repo/editor-desktop typecheck  # node + web 两套 tsconfig
```

产物在 `out/`：

- `out/main/index.js`（ESM）
- `out/preload/index.mjs`（`"type": "module"` 下 electron-vite 产出 ESM 预加载）
- `out/renderer/`（Vite 打包的静态资源）

> 主进程按 `.mjs` 指向预加载脚本，并关闭了 `sandbox`（ESM preload 需要）。

## 架构

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

## 内置工具

`read_file` / `write_file` / `edit_file` / `apply_patch` / `delete_file` / `move_file` /
`create_directory` / `list_dir` / `search_files` / `glob` / `run_terminal` /
`git_status` / `git_diff`

## 功能

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

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+S` | 保存当前文件 |
| `` Ctrl+` `` | 显示 / 隐藏终端 |
| `Ctrl+B` | 显示 / 隐藏侧栏 |
| `Ctrl+P` | 快速打开文件 |
| `Ctrl+,` | 打开设置 |
| `Esc` | 关闭弹窗 |

## 应用图标

| 位置 | 作用 |
|------|------|
| `resources/icon.ico` / `resources/icon.png` | 开发/运行时的窗口与任务栏图标（`BrowserWindow.icon` 自动读取，Windows 建议 `.ico`） |
| `build/icon.ico` / `build/icon.icns` / `build/icon.png` | 打包后的应用图标（electron-builder 的 `build.icon`） |
| `src/renderer/index.html` 的 `<link rel="icon">` | 页面 favicon（只影响浏览器标签，不影响 Electron 窗口） |
| `src/main/index.ts` 的 `title` + `index.html` 的 `<title>` | 窗口标题（当前 `DieTai Editor Desktop`） |

把图标放到 `resources/` 下（`icon.ico` 优先，其次 `icon.png`），重启 Electron 即可。

## 安全说明

- 所有文件工具都限制在工作区根目录内，越界路径直接拒绝。
- `run_terminal` 有破坏性命令黑名单；`delete_file` 只能删文件。
- 模型 API Key 存在 Electron `userData/config.json`，`safeStorage` 可用时用系统钥匙串加密。
- 本地模式目前是「工具直接写入」；diff 预览与写前确认在路线图中。
