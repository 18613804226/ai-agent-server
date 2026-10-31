import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path';
import type {
  RegisteredTool,
  ToolDefinition,
  ToolHandler,
} from '@repo/agent-orchestrator';
import type { ChangeListener } from './types.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const MAX_RESULT_CHARS = 4000;
const MAX_WALK_FILES = 2000;
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'out',
  'coverage',
]);

/**
 * 注册一个工具：把实现包一层，异常转成给模型看的错误文本。
 * 工具不应抛异常（模型只读得懂返回的字符串）。
 */
function tool(definition: ToolDefinition, handler: ToolHandler): RegisteredTool {
  return {
    definition,
    handler: async (args) => {
      try {
        return await handler(args);
      } catch (e: any) {
        return `工具执行出错：${e.message ?? '未知错误'}`;
      }
    },
  };
}

function truncate(s: string): string {
  return s.length > MAX_RESULT_CHARS
    ? `${s.slice(0, MAX_RESULT_CHARS)}\n…（结果过长，已截断）`
    : s;
}

/** 去掉前导斜杠、统一正斜杠：AI 输入常带 /test/a.js 这种路径 */
function cleanPath(s: string): string {
  return s.replace(/\\/g, '/').replace(/^\/+/, '');
}

function readTextFile(abs: string, offset?: number, limit?: number): string {
  const raw = readFileSync(abs, 'utf8');
  const lines = raw.split('\n');
  const start = Math.max(0, offset ?? 0);
  const end = limit ? Math.min(lines.length, start + limit) : lines.length;
  return lines.slice(start, end).join('\n');
}

/** 读文本，失败/二进制返回 undefined（用于 diff 的 before） */
function tryReadText(abs: string): string | undefined {
  try {
    if (!existsSync(abs) || isProbablyBinary(abs)) return undefined;
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** 跳过二进制文件（含 NUL 即视为二进制） */
function isProbablyBinary(abs: string): boolean {
  try {
    const buf = readFileSync(abs);
    return buf.slice(0, 8000).includes(0);
  } catch {
    return true;
  }
}

function listDir(abs: string): string {
  return readdirSync(abs, { withFileTypes: true })
    .map((e) => `${e.isDirectory() ? '[dir]' : '     '} ${e.name}`)
    .join('\n');
}

/** 递归收集工作区内可读的文本文件（带数量上限） */
function collectFiles(root: string, maxFiles = MAX_WALK_FILES): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue;
        walk(abs);
      } else if (st.isFile()) {
        out.push(abs);
      }
    }
  };
  walk(root);
  return out;
}

export interface WorkspaceRoot {
  name: string;
  path: string;
}

/** 单根 / 路径数组 / 带名字的根数组 */
export type WorkspaceRootsInput = string | string[] | WorkspaceRoot[];

/** 统一成多根工作区结构（单根自动取目录名作为 name） */
export function normalizeRoots(roots: WorkspaceRootsInput): WorkspaceRoot[] {
  if (typeof roots === 'string') {
    const path = resolve(roots);
    return [{ name: basename(path), path }];
  }
  return roots.map((r) =>
    typeof r === 'string'
      ? { name: basename(resolve(r)), path: resolve(r) }
      : { name: r.name, path: resolve(r.path) },
  );
}

function isInside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

/** 把路径解析到某个工作区根内；支持 `rootName/...` 前缀 */
function resolveInRoots(roots: WorkspaceRoot[], p: string): string {
  if (!p || typeof p !== 'string') throw new Error('路径不能为空');
  if (!roots.length) throw new Error('还没有打开文件夹');

  // AI 或输入常带前导斜杠（如 /test/a.js），统一去掉再按 rootName/... 解析
  const normalized = p.replace(/\\/g, '/').replace(/^\/+/, '');
  const [first, ...rest] = normalized.split('/');
  const byName = roots.find((r) => r.name === first);
  if (byName) {
    const abs = resolve(byName.path, rest.join('/'));
    if (isInside(byName.path, abs)) return abs;
    throw new Error(`路径越界：${p}（只允许访问工作区内文件）`);
  }

  if (isAbsolute(normalized)) {
    const abs = resolve(normalized);
    if (roots.some((r) => isInside(r.path, abs))) return abs;
    throw new Error(`路径越界：${p}（只允许访问工作区内文件）`);
  }

  // 相对路径：优先命中已存在的文件，否则落到第一个根
  for (const r of roots) {
    const abs = resolve(r.path, normalized);
    if (isInside(r.path, abs) && existsSync(abs)) return abs;
  }
  const abs = resolve(roots[0].path, normalized);
  if (isInside(roots[0].path, abs)) return abs;
  throw new Error(`路径越界：${p}（只允许访问工作区内文件）`);
}

interface WorkspaceFile {
  abs: string;
  /** 带根名前缀的路径（rootName/src/a.ts） */
  rel: string;
  /** 根内相对路径（src/a.ts） */
  relWithinRoot: string;
}

function collectWorkspaceFiles(
  roots: WorkspaceRoot[],
  maxFiles = MAX_WALK_FILES,
): WorkspaceFile[] {
  const out: WorkspaceFile[] = [];
  for (const root of roots) {
    for (const abs of collectFiles(root.path, maxFiles - out.length)) {
      const relWithinRoot = relative(root.path, abs).replace(/\\/g, '/');
      out.push({
        abs,
        rel: `${root.name}/${relWithinRoot}`,
        relWithinRoot,
      });
      if (out.length >= maxFiles) return out;
    }
  }
  return out;
}

/** 读文本行，失败返回空数组（权限/编码问题不炸整个搜索） */
function safeReadLines(abs: string): string[] {
  try {
    return readFileSync(abs, 'utf8').split('\n');
  } catch {
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** 极简 glob → RegExp：支持 `*`、`**`、`?`、`{a,b}` */
function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        const parts = g
          .slice(i + 1, end)
          .split(',')
          .map((p) => escapeRegExp(p));
        re += `(${parts.join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

export interface WorkspaceNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  children?: WorkspaceNode[];
}

/**
 * 创建一个绑定到工作区（单根或多根）的工具集。
 *
 * 同一套实现同时服务于：
 * - 后端（root = AGENT_WORKSPACE_ROOT）
 * - Electron 主进程（roots = 用户打开的本地文件夹）
 */
export function createEditorTools(
  rootsInput: WorkspaceRootsInput,
  onChange?: ChangeListener,
): RegisteredTool[] {
  const roots = normalizeRoots(rootsInput);
  const primary = roots[0]?.path || process.cwd();

  /** 把用户给的路径解析成某个工作区根内的绝对路径；越界抛错 */
  const safeResolve = (p: string): string => resolveInRoots(roots, p);

  return [
    tool(
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取工作区内某个文本文件的内容。可指定起始行和行数。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径，如 my-app/src/a.ts' },
              offset: { type: 'number', description: '起始行（0 起）' },
              limit: { type: 'number', description: '读取行数' },
            },
            required: ['path'],
          },
        },
      },
      async (args) => {
        const abs = safeResolve(String(args.path));
        if (!existsSync(abs)) return `文件不存在：${args.path}`;
        if (isProbablyBinary(abs)) return `二进制文件，无法读取：${args.path}`;
        return truncate(
          readTextFile(
            abs,
            Number(args.offset) || 0,
            Number(args.limit) || undefined,
          ),
        );
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'write_file',
          description:
            '把内容写入工作区内的文件（覆盖已有内容，必要时创建父目录）。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      },
      async (args) => {
        const path = String(args.path);
        const abs = safeResolve(path);
        const content = String(args.content ?? '');
        const before = tryReadText(abs);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf8');
        onChange?.({
          path: cleanPath(path),
          kind: before === undefined ? 'created' : 'modified',
          before,
          after: content,
        });
        return `已写入 ${path}（${content.length} 字）`;
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'edit_file',
          description:
            '替换工作区内文件里的指定文本（全部替换）。改代码时优先用它而不是整文件重写。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              old_string: { type: 'string', description: '要被替换的原文' },
              new_string: { type: 'string', description: '替换成的新文' },
            },
            required: ['path', 'old_string', 'new_string'],
          },
        },
      },
      async (args) => {
        const abs = safeResolve(String(args.path));
        if (!existsSync(abs)) return `文件不存在：${args.path}`;
        const raw = readFileSync(abs, 'utf8');
        const oldStr = String(args.old_string ?? '');
        if (!oldStr) return 'old_string 不能为空';
        if (!raw.includes(oldStr)) {
          return `未找到要替换的文本：${oldStr.slice(0, 60)}`;
        }
        const next = raw.split(oldStr).join(String(args.new_string ?? ''));
        writeFileSync(abs, next, 'utf8');
        onChange?.({
          path: cleanPath(String(args.path)),
          kind: 'modified',
          before: raw,
          after: next,
        });
        return `已更新 ${args.path}（替换 ${raw.split(oldStr).length - 1} 处）`;
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          description:
            '一次应用多个文件修改（原子性校验：所有 old_string 都存在才写入）。' +
            '每个 edit 用 old_string/new_string 做局部替换，或用 content 整文件覆盖。',
          parameters: {
            type: 'object',
            properties: {
              edits: {
                type: 'array',
                description: '要应用的修改列表',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    old_string: { type: 'string' },
                    new_string: { type: 'string' },
                    content: {
                      type: 'string',
                      description: '提供时整文件覆盖（忽略 old/new）',
                    },
                  },
                  required: ['path'],
                },
              },
            },
            required: ['edits'],
          },
        },
      },
      async (args) => {
        const edits = Array.isArray(args.edits) ? (args.edits as any[]) : [];
        if (!edits.length) return 'edits 不能为空';
        const planned: Array<{
          path: string;
          abs: string;
          before?: string;
          next: string;
          label: string;
        }> = [];
        for (const e of edits) {
          const path = String(e?.path);
          const abs = safeResolve(path);
          if (typeof e?.content === 'string') {
            planned.push({
              path,
              abs,
              before: tryReadText(abs),
              next: e.content,
              label: `${path}（整文件）`,
            });
            continue;
          }
          if (!existsSync(abs)) {
            return `文件不存在：${path}（整批未应用）`;
          }
          const oldStr = String(e?.old_string ?? '');
          if (!oldStr) {
            return `edit ${path} 缺少 old_string 或 content（整批未应用）`;
          }
          const raw = readFileSync(abs, 'utf8');
          if (!raw.includes(oldStr)) {
            return `未找到要替换的文本：${path}（整批未应用）`;
          }
          const count = raw.split(oldStr).length - 1;
          planned.push({
            path,
            abs,
            before: raw,
            next: raw.split(oldStr).join(String(e?.new_string ?? '')),
            label: `${path}（替换 ${count} 处）`,
          });
        }
        for (const p of planned) {
          mkdirSync(dirname(p.abs), { recursive: true });
          writeFileSync(p.abs, p.next, 'utf8');
          onChange?.({
            path: cleanPath(p.path),
            kind: p.before === undefined ? 'created' : 'modified',
            before: p.before,
            after: p.next,
          });
        }
        return `已应用 ${planned.length} 个修改：\n${planned
          .map((p) => `- ${p.label}`)
          .join('\n')}`;
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'delete_file',
          description: '删除工作区内的一个文件（不能删目录）。',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
      async (args) => {
        const path = String(args.path);
        const abs = safeResolve(path);
        if (!existsSync(abs)) return `文件不存在：${path}`;
        if (statSync(abs).isDirectory()) {
          return `拒绝：delete_file 只能删文件（目录请先清空）`;
        }
        const before = tryReadText(abs);
        rmSync(abs);
        onChange?.({ path: cleanPath(path), kind: 'deleted', before });
        return `已删除 ${path}`;
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'move_file',
          description: '移动或重命名工作区内的文件，必要时创建目标父目录。',
          parameters: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
      },
      async (args) => {
        const fromPath = String(args.from);
        const toPath = String(args.to);
        const from = safeResolve(fromPath);
        const to = safeResolve(toPath);
        if (!existsSync(from)) return `源文件不存在：${fromPath}`;
        const before = tryReadText(from);
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
        onChange?.({
          path: cleanPath(toPath),
          kind: 'renamed',
          from: cleanPath(fromPath),
          before,
          after: before,
        });
        return `已移动 ${fromPath} → ${toPath}`;
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'create_directory',
          description: '在工作区内创建目录（递归创建，已存在也成功）。',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
      async (args) => {
        const abs = safeResolve(String(args.path));
        mkdirSync(abs, { recursive: true });
        return `已创建目录 ${args.path}`;
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'list_dir',
          description: '列出工作区内某个目录下的文件和子目录。',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
      async (args) => {
        const abs = safeResolve(String(args.path));
        if (!existsSync(abs)) return `目录不存在：${args.path}`;
        if (!statSync(abs).isDirectory()) return `不是目录：${args.path}`;
        return listDir(abs);
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'search_files',
          description:
            '在工作区内按正则搜索文件内容，返回匹配的文件名与行号。用于定位符号、字符串等。',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: '正则表达式' },
              path: { type: 'string', description: '起始目录（默认所有根）' },
            },
            required: ['pattern'],
          },
        },
      },
      async (args) => {
        const base = args.path ? safeResolve(String(args.path)) : null;
        let re: RegExp;
        try {
          re = new RegExp(String(args.pattern), 'gm');
        } catch {
          return `非法正则：${args.pattern}`;
        }
        const hits: string[] = [];
        for (const file of collectWorkspaceFiles(roots)) {
          if (base && !isInside(base, file.abs)) continue;
          if (hits.length >= 50) break;
          if (isProbablyBinary(file.abs)) continue;
          const lines = safeReadLines(file.abs);
          lines.forEach((line, i) => {
            if (hits.length >= 50) return;
            re.lastIndex = 0;
            if (re.test(line)) {
              hits.push(`${file.rel}:${i + 1}: ${line.trim()}`);
            }
          });
        }
        return hits.length ? hits.join('\n') : `没有匹配：${args.pattern}`;
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'glob',
          description:
            '按文件名模式查找文件，支持 *、**、?、{a,b}。例如 "**/*.ts"、"src/**/*.{ts,tsx}"。',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'glob 模式' },
              path: { type: 'string', description: '起始目录（默认所有根）' },
            },
            required: ['pattern'],
          },
        },
      },
      async (args) => {
        const pattern = String(args.pattern ?? '');
        if (!pattern) return 'pattern 不能为空';
        const base = args.path ? safeResolve(String(args.path)) : null;
        const re = globToRegExp(pattern);
        const patternHasSlash = pattern.replace(/\\/g, '/').includes('/');
        const hits: string[] = [];
        for (const file of collectWorkspaceFiles(roots)) {
          if (base && !isInside(base, file.abs)) continue;
          const baseName = file.rel.slice(file.rel.lastIndexOf('/') + 1);
          const matched =
            re.test(file.rel) ||
            re.test(file.relWithinRoot) ||
            (!patternHasSlash && re.test(baseName));
          if (matched) {
            hits.push(file.rel);
            if (hits.length >= 200) break;
          }
        }
        return hits.length ? hits.join('\n') : `没有匹配：${pattern}`;
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'run_terminal',
          description:
            '在工作区目录执行一条终端命令并返回输出。仅用于构建、测试、git 状态等只读/安全操作。',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      },
      async (args) => {
        const command = String(args.command ?? '');
        if (!command.trim()) return '命令不能为空';
        const denied =
          /rm\s+-rf|rd\s+\/s|format\s+[a-z]:|mkfs|dd\s+if=|:?\(\)\s*\{|shutdown|reboot|del\s+\/[sq]/i;
        if (denied.test(command)) {
          return `命令被拒绝（疑似破坏性）：${command}`;
        }
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: primary,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          });
          const out = `${stdout || ''}${stderr || ''}`.trim();
          return truncate(out || '（命令无输出）');
        } catch (e: any) {
          const out = `${e.stdout || ''}${e.stderr || ''}`.trim();
          return truncate(`${out || e.message || '命令执行失败'}`);
        }
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'git_status',
          description: '查看主工作区的 git 状态（git status --porcelain）。',
          parameters: { type: 'object', properties: {} },
        },
      },
      async () => {
        try {
          const { stdout, stderr } = await execFileAsync(
            'git',
            ['status', '--porcelain'],
            {
              cwd: primary,
              timeout: 15000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
            },
          );
          const out = `${stdout || ''}${stderr || ''}`.trim();
          return truncate(out || '（工作区干净）');
        } catch (e: any) {
          return `git status 失败：${e?.message || e}`;
        }
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'git_diff',
          description: '查看主工作区的未提交改动（git diff），可指定单个路径。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '可选：只看某个文件/目录' },
            },
          },
        },
      },
      async (args) => {
        const p = args.path ? String(args.path) : undefined;
        try {
          const { stdout, stderr } = await execFileAsync(
            'git',
            ['diff', ...(p ? ['--', p] : [])],
            {
              cwd: primary,
              timeout: 15000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
            },
          );
          const out = `${stdout || ''}${stderr || ''}`.trim();
          return truncate(out || '（没有未提交改动）');
        } catch (e: any) {
          return `git diff 失败：${e?.message || e}`;
        }
      },
    ),
  ];
}

/** 工作区里有哪些目录（给 prompt 用） */
export function workspaceSummary(rootsInput: WorkspaceRootsInput): string {
  const roots = normalizeRoots(rootsInput);
  return roots
    .map((root) => {
      try {
        if (!existsSync(root.path)) {
          return `【${root.name}】${root.path}（不存在）`;
        }
        return `【${root.name}】${root.path}\n${listDir(root.path)}`;
      } catch (e: any) {
        return `【${root.name}】${root.path}（无法读取：${e.message}）`;
      }
    })
    .join('\n\n');
}

function buildChildren(
  abs: string,
  relPrefix: string,
  depth: number,
  maxDepth: number,
): WorkspaceNode[] {
  if (depth >= maxDepth || !existsSync(abs)) return [];
  const nodes: WorkspaceNode[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const childAbs = join(abs, entry.name);
    const childRel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        type: 'dir',
        path: childRel,
        children: buildChildren(childAbs, childRel, depth + 1, maxDepth),
      });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, type: 'file', path: childRel });
    }
  }
  return nodes;
}

/**
 * 构建多根工作区目录树：每个根是顶层节点，子节点路径带 `rootName/` 前缀。
 */
export function buildWorkspaceTree(
  rootsInput: WorkspaceRootsInput,
  relativePath = '',
  depth = 0,
  maxDepth = 4,
): WorkspaceNode[] {
  const roots = normalizeRoots(rootsInput);
  if (!relativePath) {
    return roots.map((root) => ({
      name: root.name,
      type: 'dir' as const,
      path: root.name,
      children: buildChildren(root.path, root.name, depth + 1, maxDepth),
    }));
  }
  const abs = resolveInRoots(roots, relativePath);
  return buildChildren(abs, relativePath, depth, maxDepth);
}

/** 写入工作区内某个文件（越界拒绝，自动创建父目录） */
export function writeWorkspaceFile(
  rootsInput: WorkspaceRootsInput,
  relativePath: string,
  content: string,
): void {
  const roots = normalizeRoots(rootsInput);
  const abs = resolveInRoots(roots, relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** 创建工作区目录（递归） */
export function createWorkspaceDirectory(
  rootsInput: WorkspaceRootsInput,
  relativePath: string,
): void {
  const roots = normalizeRoots(rootsInput);
  const abs = resolveInRoots(roots, relativePath);
  mkdirSync(abs, { recursive: true });
}

/** 删除文件或空目录 */
export function deleteWorkspacePath(
  rootsInput: WorkspaceRootsInput,
  relativePath: string,
): void {
  const roots = normalizeRoots(rootsInput);
  const abs = resolveInRoots(roots, relativePath);
  if (!existsSync(abs)) throw new Error(`路径不存在：${relativePath}`);
  if (statSync(abs).isDirectory()) {
    rmdirSync(abs); // 只删空目录，避免误删整个项目
  } else {
    rmSync(abs);
  }
}

/** 重命名/移动文件或目录 */
export function renameWorkspacePath(
  rootsInput: WorkspaceRootsInput,
  from: string,
  to: string,
): void {
  const roots = normalizeRoots(rootsInput);
  const fromAbs = resolveInRoots(roots, from);
  const toAbs = resolveInRoots(roots, to);
  if (!existsSync(fromAbs)) throw new Error(`路径不存在：${from}`);
  mkdirSync(dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);
}

/** 读取工作区内某个文件（越界/二进制抛错） */
export function readWorkspaceFile(
  rootsInput: WorkspaceRootsInput,
  relativePath: string,
): string {
  const roots = normalizeRoots(rootsInput);
  const abs = resolveInRoots(roots, relativePath);
  if (!existsSync(abs)) throw new Error(`文件不存在：${relativePath}`);
  if (isProbablyBinary(abs)) {
    throw new Error(`二进制文件，无法读取：${relativePath}`);
  }
  return readTextFile(abs);
}
