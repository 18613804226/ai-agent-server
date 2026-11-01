import type { AgentDefinition } from '@repo/agent-orchestrator';
import { buildGeneralSystemPrompt } from './prompt.js';
import { createGeneralTools } from './tools.js';

/** 通用 agent：工具集 + prompt 均由本包提供，宿主只负责路由与事件消费 */
export const generalAgent: AgentDefinition = {
  id: 'general',
  tools: createGeneralTools(),
  buildSystemPrompt: buildGeneralSystemPrompt,
};
