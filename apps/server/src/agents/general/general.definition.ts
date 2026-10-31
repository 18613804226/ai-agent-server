import type { AgentDefinition } from '../types.js';
import { generalTools } from './general.tools.js';
import { buildGeneralSystemPrompt } from './general.prompt.js';

export const generalAgent: AgentDefinition = {
  id: 'general',
  tools: generalTools,
  buildSystemPrompt: buildGeneralSystemPrompt,
};
