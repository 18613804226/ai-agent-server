import { join, resolve } from 'path';

/** 服务端 editor agent 的工作区根目录（所有文件工具都限制在这里面） */
export const WORKSPACE_ROOT = resolve(
  process.env.AGENT_WORKSPACE_ROOT || join(process.cwd(), 'workspace'),
);
