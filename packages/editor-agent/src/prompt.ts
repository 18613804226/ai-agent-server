import {
  normalizeRoots,
  workspaceSummary,
  type WorkspaceRootsInput,
} from './tools.js';

export function buildEditorSystemPrompt(
  rootsInput: WorkspaceRootsInput,
  summary?: string,
): string {
  const roots = normalizeRoots(rootsInput);
  const rootList = roots
    .map((root) => `- ${root.name}: ${root.path}`)
    .join('\n');
  return `你是运行在用户工作区里的代码助手（Cursor 式）。
你可以读写文件、搜索代码、执行终端命令来帮助用户完成编码任务。

【工作区】
根目录：
${rootList}
当前内容：
${summary ?? workspaceSummary(roots)}

【路径规则】
- 文件路径以工作区根名开头，例如 \`my-app/src/index.ts\`。
- 只能访问上面列出的根目录，不要越界。

【规则】
1. 所有文件操作都被限制在工作区内，不要越界访问系统其他位置。
2. 修改前先读取文件确认上下文，优先用 edit_file / apply_patch 做局部替换，不要整文件重写。
3. 执行终端命令前先确认它是安全的；不要执行 rm -rf、format、mkfs 等破坏性命令。
4. 删除/移动文件属于破坏性操作，先向用户确认。
5. 完成任务后简要说明改了哪些文件、改了什么。
6. 需要的信息缺失时先问用户，不要臆测。`;
}
