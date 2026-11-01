import type {
  AgentDefinition,
  VerifyHook,
} from '@repo/agent-orchestrator';
import { createEditorTools, type WorkspaceRootsInput } from './tools.js';
import { buildEditorSystemPrompt } from './prompt.js';
import { createVerifier } from './verify.js';
import type { ChangeListener } from './types.js';

/** 默认会触发自动验证的编辑类工具 */
export const DEFAULT_EDIT_TOOL_NAMES = [
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'move_file',
];

export interface CreateEditorAgentOptions {
  /**
   * 自动验证器：
   * - 不传：按工作区 package.json 创建默认验证器（typecheck/lint）
   * - 传 null：关闭自动验证（云端代理模式用，客户端通过 verify_workspace 工具验证）
   */
  verifier?: VerifyHook | null;
}

/**
 * 创建固定到工作区（单根或多根）的 editor agent。
 * 后端和 Electron 主进程用同一份实现，只是 roots 不同。
 *
 * @param onChange 可选：工具产生文件改动时回调，宿主可据此展示 diff
 */
export function createEditorAgent(
  roots: WorkspaceRootsInput,
  onChange?: ChangeListener,
  options: CreateEditorAgentOptions = {},
): AgentDefinition {
  const verifier =
    options.verifier === null
      ? null
      : options.verifier ?? createVerifier(roots);

  const tools = createEditorTools(roots, onChange);
  tools.push({
    definition: {
      type: 'function',
      function: {
        name: 'verify_workspace',
        description:
          '验证当前工作区：运行 package.json 里的 typecheck / lint 脚本，返回通过或失败详情。修改文件后应调用它确认改动没问题。可传 scripts 指定额外脚本（如 ["test"]）。',
        parameters: {
          type: 'object',
          properties: {
            scripts: {
              type: 'array',
              items: { type: 'string' },
              description: '要运行的 npm scripts，如 ["test"]',
            },
          },
        },
      },
    },
    handler: async (args, context) => {
      if (!verifier) {
        return '当前模式没有可用的验证脚本（typecheck / lint）。';
      }
      const scripts = Array.isArray(args.scripts)
        ? args.scripts.map((s) => String(s))
        : undefined;
      const result = await verifier({
        toolNames: ['verify_workspace'],
        scripts,
        signal: context.signal,
      });
      return result ?? '没有找到可用的验证脚本（typecheck / lint）。';
    },
  });

  return {
    id: 'editor',
    tools,
    buildSystemPrompt: (input) =>
      buildEditorSystemPrompt(roots, undefined, input?.context),
    verifyAfterTools: verifier ?? undefined,
    editToolNames: DEFAULT_EDIT_TOOL_NAMES,
  };
}
