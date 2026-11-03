/** 规范化文件路径：去掉前导斜杠/反斜杠，统一正斜杠（AI 入参常带 /） */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}
