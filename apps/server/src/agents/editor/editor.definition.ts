import { createEditorAgent } from '@repo/editor-agent';
import { WORKSPACE_ROOT } from './workspace-root.js';

export const editorAgent = createEditorAgent(WORKSPACE_ROOT);
