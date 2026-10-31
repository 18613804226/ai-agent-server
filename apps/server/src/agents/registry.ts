import { editorAgent } from './editor/editor.definition.js';
import { generalAgent } from './general/general.definition.js';
import type { AgentDefinition } from './types.js';

/** agent id → 定义。新增 agent 只需在这里注册。 */
export const AGENTS: Record<string, AgentDefinition> = {
  editor: editorAgent,
  general: generalAgent,
};

export function getAgent(id: string): AgentDefinition | undefined {
  return AGENTS[id];
}

export function listAgents(): Array<{ id: string; toolCount: number }> {
  return Object.values(AGENTS).map((a) => ({
    id: a.id,
    toolCount: a.tools.length,
  }));
}
