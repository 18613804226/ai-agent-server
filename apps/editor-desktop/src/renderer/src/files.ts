import type { WorkspaceNode } from './mode/types';

/** 把工作区目录树拍平成文件路径列表 */
export function flattenFiles(
  nodes: WorkspaceNode[],
  out: string[] = [],
): string[] {
  for (const node of nodes) {
    if (node.type === 'file') out.push(node.path);
    else if (node.children) flattenFiles(node.children, out);
  }
  return out;
}

/** 从输入里提取 `@path` 引用 */
export function extractMentions(text: string): string[] {
  const re = /(?:^|\s)@([^\s@]+)/g;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) out.push(match[1]);
  return [...new Set(out)];
}
