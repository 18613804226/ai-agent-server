/**
 * 浏览器安全入口：仅供渲染进程等客户端代码使用。
 * 只导出不依赖 Node 内置模块的类型和纯函数，
 * 避免把 exec.ts（util/child_process）等 Node 侧代码打进浏览器包。
 */
export * from './types.js';
export * from './database.js';