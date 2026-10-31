import type { AgentDefinition } from '@repo/agent-orchestrator';
import { createEditorTools, type WorkspaceRootsInput } from './tools.js';
import { buildEditorSystemPrompt } from './prompt.js';
import type { ChangeListener } from './types.js';

/**
 * 创建一个绑定到工作区（单根或多根）的 editor agent。
 * 后端和 Electron 主进程用同一套实现，只是 roots 不同。
 *
 * @param onChange 可选：工具产生文件改动时回调，宿主可据此展示 diff
 */
export function createEditorAgent(
  roots: WorkspaceRootsInput,
  onChange?: ChangeListener,
): AgentDefinition {
  return {
    id: 'editor',
    tools: createEditorTools(roots, onChange),
    buildSystemPrompt: () => buildEditorSystemPrompt(roots),
  };
}
