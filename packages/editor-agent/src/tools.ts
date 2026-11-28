import { spawn } from 'child_process';
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
  FileChange,
  RegisteredTool,
  ToolDefinition,
  ToolHandler,
} from '@repo/agent-orchestrator';
import type { ChangeListener } from './types.js';
import { decodeProcOutput, execAsync, execFileAsync } from './exec.js';

const MAX_RESULT_CHARS = 4000;
const MAX_WALK_FILES = 2000;
/** deferWrite 模式下所有改动都没落盘，统一在工具结果里提示模型 */
const PENDING_NOTE =
  '（当前为 diff 审批模式，文件尚未写入磁盘，用户确认后才会落盘）';

/** 同一轮内 pending 改动的叠加状态：后续编辑基于未落盘内容计算 */
export interface PendingEditState {
  before?: string;
  after: string;
}
export type PendingEditStore = Map<string, PendingEditState>;
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
    handler: async (args, context) => {
      try {
        return await handler(args, context);
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

/** HTTP 响应体字节上限：先限流读取，避免大响应整段进内存 */
const MAX_HTTP_BODY_BYTES = 1_000_000;

async function readResponseBody(
  res: Response,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: '', bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    const remain = MAX_HTTP_BODY_BYTES - bytes;
    if (value.length > remain) {
      if (remain > 0) {
        chunks.push(value.subarray(0, remain));
        bytes += remain;
      }
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // 取消失败不影响已读内容
      }
      break;
    }
    chunks.push(value);
    bytes += value.length;
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
      'utf8',
    ),
    bytes,
    truncated,
  };
}

/** 超过这个长度就转 artifact，避免大文件全文进上下文 */
const ARTIFACT_THRESHOLD = 4000;

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
  onBrowserOpen?: (url: string) => void,
  /** true=文件改动不直接落盘，产出 pending diff 等用户确认 */
  deferWrite?: boolean,
  /** 同一轮 pending 改动的叠加状态（宿主在每轮开始时清空） */
  pendingEdits?: PendingEditStore,
): RegisteredTool[] {
  const roots = normalizeRoots(rootsInput);
  const primary = roots[0]?.path || process.cwd();

  /** pending 叠加：同路径连续编辑时基于上一条 after 计算，避免互相覆盖 */
  const pendingKey = (p: string) => cleanPath(p);
  const pendingStore =
    pendingEdits ??
    (deferWrite ? new Map<string, PendingEditState>() : undefined);
  const priorEdit = (p: string) => pendingStore?.get(pendingKey(p));

  /** 把用户给的路径解析成某个工作区根内的绝对路径；越界抛错 */
  const safeResolve = (p: string): string => resolveInRoots(roots, p);

  const tools: RegisteredTool[] = [
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
      async (args, context) => {
        const abs = safeResolve(String(args.path));
        if (!existsSync(abs)) return `文件不存在：${args.path}`;
        if (isProbablyBinary(abs)) return `二进制文件，无法读取：${args.path}`;
        const content = readTextFile(
          abs,
          Number(args.offset) || 0,
          Number(args.limit) || undefined,
        );
        if (content.length > ARTIFACT_THRESHOLD && context.artifacts) {
          const id = context.artifacts.create(content, {
            path: String(args.path),
          });
          return `【文件较大，已存为 artifact】\nartifact: ${id}\n预览（前 1000 字符）：\n${content.slice(0, 1000)}\n\n需要全文请调用 read_artifact，参数 {"id":"${id}"}`;
        }
        return truncate(content);
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
        const key = pendingKey(path);
        const prior = priorEdit(path);
        const before = prior ? prior.before : tryReadText(abs);
        // deferWrite：只产出待确认 diff，不写文件
        if (deferWrite) {
          pendingStore?.set(key, { before, after: content });
          onChange?.({
            path: key,
            kind: before === undefined ? 'created' : 'modified',
            before,
            after: content,
            pending: true,
          });
          return `已生成对 ${path} 的改动，等待用户确认后写入${PENDING_NOTE}`;
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf8');
        onChange?.({
          path: key,
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
        const path = String(args.path);
        const abs = safeResolve(path);
        const key = pendingKey(path);
        const prior = priorEdit(path);
        if (!prior && !existsSync(abs)) return `文件不存在：${args.path}`;
        // pending 叠加：本轮先生成但未落盘的改动也要作为后续编辑的基础
        const raw = prior?.after ?? readFileSync(abs, 'utf8');
        const before = prior ? prior.before : raw;
        const oldStr = String(args.old_string ?? '');
        if (!oldStr) return 'old_string 不能为空';
        if (!raw.includes(oldStr)) {
          return `未找到要替换的文本：${oldStr.slice(0, 60)}`;
        }
        const next = raw.split(oldStr).join(String(args.new_string ?? ''));
        // deferWrite：只产出待确认 diff，不写文件
        if (deferWrite) {
          pendingStore?.set(key, { before, after: next });
          onChange?.({
            path: key,
            kind: before === undefined ? 'created' : 'modified',
            before,
            after: next,
            pending: true,
          });
          return `已生成对 ${args.path} 的改动，等待用户确认后写入${PENDING_NOTE}`;
        }
        writeFileSync(abs, next, 'utf8');
        onChange?.({
          path: key,
          kind: before === undefined ? 'created' : 'modified',
          before,
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
          key: string;
          abs: string;
          before?: string;
          next: string;
          label: string;
        }> = [];
        // 同一次 apply_patch 内多个 edit 命中同一文件时也按顺序叠加
        const staged = new Map<string, PendingEditState>();
        for (const e of edits) {
          const path = String(e?.path);
          const key = pendingKey(path);
          const abs = safeResolve(path);
          const prior = staged.get(key) ?? priorEdit(path);
          if (typeof e?.content === 'string') {
            const before = prior ? prior.before : tryReadText(abs);
            planned.push({
              path,
              key,
              abs,
              before,
              next: e.content,
              label: `${path}（整文件）`,
            });
            staged.set(key, { before, after: e.content });
            continue;
          }
          if (!prior && !existsSync(abs)) {
            return `文件不存在：${path}（整批未应用）`;
          }
          const oldStr = String(e?.old_string ?? '');
          if (!oldStr) {
            return `edit ${path} 缺少 old_string 或 content（整批未应用）`;
          }
          const base = prior?.after ?? readFileSync(abs, 'utf8');
          if (!base.includes(oldStr)) {
            return `未找到要替换的文本：${path}（整批未应用）`;
          }
          const before = prior ? prior.before : base;
          const next = base.split(oldStr).join(String(e?.new_string ?? ''));
          planned.push({
            path,
            key,
            abs,
            before,
            next,
            label: `${path}（替换 ${base.split(oldStr).length - 1} 处）`,
          });
          staged.set(key, { before, after: next });
        }
        for (const p of planned) {
          if (deferWrite) {
            pendingStore?.set(p.key, { before: p.before, after: p.next });
            onChange?.({
              path: p.key,
              kind: p.before === undefined ? 'created' : 'modified',
              before: p.before,
              after: p.next,
              pending: true,
            });
            continue;
          }
          mkdirSync(dirname(p.abs), { recursive: true });
          writeFileSync(p.abs, p.next, 'utf8');
          onChange?.({
            path: p.key,
            kind: p.before === undefined ? 'created' : 'modified',
            before: p.before,
            after: p.next,
          });
        }
        return `${deferWrite ? '已生成' : '已应用'} ${planned.length} 个修改：\n${planned
          .map((p) => `- ${p.label}`)
          .join('\n')}${deferWrite ? `\n${PENDING_NOTE}` : ''}`;
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
        const prior = priorEdit(path);
        const before = prior ? prior.before : tryReadText(abs);
        if (deferWrite) {
          if (before === undefined) {
            return `无法读取 ${path} 的文本内容（可能是二进制文件）。diff 审批模式不支持删除二进制文件，请让用户关闭文件审批后重试或手动删除。`;
          }
          const key = pendingKey(path);
          pendingStore?.set(key, { before, after: '' });
          onChange?.({
            path: key,
            kind: 'deleted',
            before,
            after: '',
            pending: true,
          });
          return `已生成删除 ${path} 的改动，等待用户确认后执行${PENDING_NOTE}`;
        }
        rmSync(abs);
        onChange?.({
          path: pendingKey(path),
          kind: 'deleted',
          before,
        });
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
        const fromKey = pendingKey(fromPath);
        const toKey = pendingKey(toPath);
        const priorFrom = priorEdit(fromPath);
        const before = priorFrom ? priorFrom.before : tryReadText(from);
        // 本轮已有未落盘改动时，移动要带上最新内容，否则确认后会丢失
        const next = priorFrom?.after ?? before;
        if (deferWrite) {
          pendingStore?.delete(fromKey);
          if (next !== undefined) {
            pendingStore?.set(toKey, { before, after: next });
          }
          onChange?.({
            path: toKey,
            kind: 'renamed',
            from: fromKey,
            before,
            after: next,
            pending: true,
          });
          return `已生成移动 ${fromPath} → ${toPath} 的改动，等待用户确认后执行${PENDING_NOTE}`;
        }
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
        onChange?.({
          path: toKey,
          kind: 'renamed',
          from: fromKey,
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
        const existed = existsSync(abs);
        mkdirSync(abs, { recursive: true });
        return existed
          ? `目录已存在：${args.path}`
          : `目录已创建：${args.path}`;
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
            '在工作区目录执行一条终端命令并返回输出。仅用于构建、测试、git 状态等只读/安全操作。启动 Web 项目前先读 package.json 的 scripts，优先用项目自带命令（npm run dev / serve / vite）。如果没有 package.json 或 scripts 里没有 dev/serve，用 Node.js 启动静态服务器（npx serve / npx http-server），不要用 python -m http.server。注意：命令里的相对路径以工作区根为基准，不要加根名前缀（用 vue-app/index.html，而不是 test/vue-app/index.html）。',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              background: {
                type: 'boolean',
                description:
                  '是否后台运行（用于 dev server 等长期进程，立即返回不等待）',
              },
            },
            required: ['command'],
          },
        },
      },
      async (args) => {
        const command = String(args.command ?? '');
        const background = Boolean(args.background);
        if (!command.trim()) return '命令不能为空';
        const denied =
          /rm\s+-rf|rd\s+\/s|format\s+[a-z]:|mkfs|dd\s+if=|:?\(\)\s*\{|shutdown|reboot|del\s+\/[sq]/i;
        if (denied.test(command)) {
          return `命令被拒绝（疑似破坏性）：${command}`;
        }
        // 拒绝用 python 起静态服务器：Windows 下编码乱码，且不是正确的 Web 项目启动方式
        if (/python\s+-m\s+http\.server/i.test(command)) {
          return (
            '命令被拒绝：不要用 python -m http.server 启动静态服务。' +
            '请改用 Node.js：npx serve . 或 npx http-server .'
          );
        }
        // 后台运行：用于 dev server 等长期进程，立即返回
        if (background) {
          const child = spawn('cmd.exe', ['/c', command], {
            cwd: primary,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.unref();
          return `已在后台启动（PID ${child.pid}）：${command}。可用内置浏览器打开对应地址查看。`;
        }
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: primary,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            encoding: 'buffer',
          });
          const out = decodeProcOutput(stdout, stderr).trim();
          return truncate(out || '（命令无输出）');
        } catch (e: any) {
          const out = decodeProcOutput(e.stdout, e.stderr).trim();
          const code = e.code != null ? `（退出码 ${e.code}）` : '';
          return truncate(
            `${out || e.message || '命令执行失败'}${code ? ` ${code}` : ''}\n提示：同一命令失败不要原样重试超过 2 次，请换思路或询问用户。`,
          );
        }
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'http_request',
          description:
            '发送 HTTP 请求调试接口（等价 curl）：返回状态码、耗时、响应头和响应体。支持 GET/POST/PUT/PATCH/DELETE 等；用于调试本地或远程 API，不要用它下载大文件。',
          parameters: {
            type: 'object',
            properties: {
              method: {
                type: 'string',
                description: 'HTTP 方法，默认 GET',
              },
              url: {
                type: 'string',
                description: '完整 URL，如 http://localhost:3000/api/users',
              },
              headers: {
                type: 'object',
                description: '请求头，如 {"Content-Type":"application/json"}',
                additionalProperties: { type: 'string' },
              },
              body: {
                type: 'string',
                description: '请求体（JSON 字符串或表单文本）',
              },
              timeout_ms: {
                type: 'number',
                description: '超时毫秒数，默认 30000，最大 60000',
              },
            },
            required: ['url'],
          },
        },
      },
      async (args, context) => {
        const url = String(args.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) {
          return `URL 不被支持：只允许 http/https（收到：${url}）`;
        }
        const method = String(args.method ?? 'GET').toUpperCase();
        const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
        if (!allowed.includes(method)) {
          return `不支持的 HTTP 方法：${method}`;
        }
        const rawHeaders =
          args.headers && typeof args.headers === 'object'
            ? (args.headers as Record<string, unknown>)
            : {};
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawHeaders)) {
          if (value !== undefined && value !== null) {
            headers[key] = String(value);
          }
        }
        const timeout = Math.min(
          60000,
          Math.max(1000, Number(args.timeout_ms) || 30000),
        );
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        timer.unref?.();
        const signal = context.signal
          ? AbortSignal.any([context.signal, controller.signal])
          : controller.signal;
        const startedAt = Date.now();
        try {
          const res = await fetch(url, {
            method,
            headers,
            body:
              method === 'GET' || method === 'HEAD'
                ? undefined
                : typeof args.body === 'string'
                  ? args.body
                  : undefined,
            signal,
            redirect: 'follow',
          });
          const elapsed = Date.now() - startedAt;
          const contentType = res.headers.get('content-type') ?? '';
          const raw = await readResponseBody(res);
          let body = raw.text;
          if (body.includes('\0')) {
            body = `（二进制响应，已读取 ${raw.bytes} 字节，已省略内容）`;
          } else if (/json/i.test(contentType) && body) {
            try {
              body = JSON.stringify(JSON.parse(body), null, 2);
            } catch {
              // 非法 JSON 原样返回
            }
          }
          if (raw.truncated) {
            body = `${body}\n…（响应体超过 ${raw.bytes} 字节上限，已截断）`;
          }
          if (body.length > MAX_RESULT_CHARS) {
            body = `${body.slice(0, MAX_RESULT_CHARS)}\n…（响应体过长，已截断）`;
          }
          const headerLines = [...res.headers.entries()]
            .slice(0, 30)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');
          return [
            `HTTP ${res.status} ${res.statusText}（${elapsed}ms）`,
            headerLines,
            '',
            body || '（空响应体）',
          ].join('\n');
        } catch (e: any) {
          const elapsed = Date.now() - startedAt;
          return `请求失败（${method} ${url}，${elapsed}ms）：${
            e?.name === 'AbortError' ? `超时（${timeout}ms）` : e?.message || e
          }`;
        } finally {
          clearTimeout(timer);
        }
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'open_in_browser',
          description:
            '在内置浏览器中打开指定 URL（仅支持 http://localhost / 127.0.0.1）。启动 Web 项目后调用它让用户预览。',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: '如 http://localhost:3000' },
            },
            required: ['url'],
          },
        },
      },
      async (args) => {
        // 模型有时会把地址写成 Markdown（**url**、`url`），这里清洗后再校验
        const url = String(args.url ?? '')
          .replace(/\*\*/g, '')
          .replace(/[`*_]/g, '')
          .trim();
        if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) {
          return `URL 不被支持：只能打开 http://localhost 或 http://127.0.0.1 的地址（收到：${url}）`;
        }
        if (!onBrowserOpen) {
          return '当前模式不支持内置浏览器，请告诉用户在浏览器中打开该地址';
        }
        onBrowserOpen(url);
        return `已在内置浏览器中打开 ${url}`;
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'git_status',
          description:
            '查看主工作区的 git 状态（git status --porcelain -b，含分支与未跟踪文件）。',
          parameters: { type: 'object', properties: {} },
        },
      },
      async () => {
        try {
          const { stdout, stderr } = await execFileAsync(
            'git',
            ['status', '--porcelain=v1', '-b'],
            {
              cwd: primary,
              timeout: 15000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
              encoding: 'buffer',
            },
          );
          const out = decodeProcOutput(stdout, stderr).trim();
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
          description:
            '查看主工作区的未提交改动（默认 diff HEAD，含暂存与未暂存），可指定单个路径；staged=true 只看暂存区。未跟踪文件不在 diff 里，会单独列出。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '可选：只看某个文件/目录' },
              staged: {
                type: 'boolean',
                description: '可选：只看已暂存的改动（git diff --cached）',
              },
            },
          },
        },
      },
      async (args) => {
        const p = args.path ? String(args.path) : undefined;
        const staged = Boolean(args.staged);
        try {
          // 仓库还没有首个 commit 时没有 HEAD，退化为工作区 diff
          let base = staged ? ['--cached'] : ['HEAD'];
          if (!staged) {
            try {
              await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
                cwd: primary,
                timeout: 10000,
                windowsHide: true,
              });
            } catch {
              base = [];
            }
          }
          const { stdout, stderr } = await execFileAsync(
            'git',
            ['diff', ...base, ...(p ? ['--', p] : [])],
            {
              cwd: primary,
              timeout: 15000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
              encoding: 'buffer',
            },
          );
          const out = decodeProcOutput(stdout, stderr).trim();
          let untracked: string[] = [];
          if (!p && !staged) {
            try {
              const others = await execFileAsync(
                'git',
                ['ls-files', '--others', '--exclude-standard'],
                {
                  cwd: primary,
                  timeout: 15000,
                  maxBuffer: 1024 * 1024,
                  windowsHide: true,
                  encoding: 'utf8',
                },
              );
              untracked = others.stdout
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .slice(0, 30);
            } catch {
              // 非 git 仓库或命令失败时忽略未跟踪列表
            }
          }
          const untrackedNote = untracked.length
            ? `\n\n未跟踪文件（不在 diff 中）：\n${untracked.join('\n')}`
            : '';
          return truncate(
            `${out || (untracked.length ? '（没有已跟踪文件的改动）' : '（没有未提交改动）')}${untrackedNote}`,
          );
        } catch (e: any) {
          return `git diff 失败：${e?.message || e}`;
        }
      },
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'read_artifact',
          description:
            '读取之前工具返回的 artifact 全文（大文件、大结果）。参数是 artifact id。',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'artifact id' },
            },
            required: ['id'],
          },
        },
      },
      async (args, context) => {
        const id = String(args.id ?? '');
        const content = context.artifacts?.get(id);
        return content ?? `未找到 artifact：${id}`;
      },
    ),
    // 澄清工具：模型信息不足/需要用户决策时调用，由宿主挂起等待用户选择或输入。
    // 不标 readOnly：需要串行执行，保证提问发生在后续写操作之前。
    tool(
      {
        type: 'function',
        function: {
          name: 'ask_user',
          description:
            '当任务信息不足、存在多种合理方案或需要用户偏好时，向用户提问并等待回答。给出 2-5 个具体选项，用户也可以自定义输入。仅在关键决策点使用，不要事事提问。',
          parameters: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '要向用户提出的问题' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: '2-5 个候选答案，要具体、互斥',
              },
              allowCustom: {
                type: 'boolean',
                description: '是否允许用户输入自定义答案，默认 true',
              },
            },
            required: ['question', 'options'],
          },
        },
      },
      async () => '（用户未响应）',
    ),
    // 任务清单：模型规划/跟踪任务进度，宿主渲染为面板（分组 + 状态）。
    // 不标 readOnly：串行执行，保证清单更新按调用顺序生效。
    tool(
      {
        type: 'function',
        function: {
          name: 'todo_write',
          description:
            '维护任务清单：任务开始前列出计划，执行中更新状态（pending / in_progress / completed），完成后核对。可用 group 给条目分组。每次调用传入完整清单（整体覆盖）。',
          parameters: {
            type: 'object',
            properties: {
              todos: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    content: { type: 'string', description: '任务内容' },
                    status: {
                      type: 'string',
                      enum: ['pending', 'in_progress', 'completed'],
                      description: '状态：待办 / 进行中 / 已完成',
                    },
                    group: {
                      type: 'string',
                      description: '分组名（可选），如「前端」「修复」',
                    },
                  },
                  required: ['content', 'status'],
                },
                description: '完整任务清单（整体覆盖，不是增量）',
              },
            },
            required: ['todos'],
          },
        },
      },
      async (args) => {
        const count = Array.isArray(args.todos) ? args.todos.length : 0;
        return `（任务清单已更新，共 ${count} 项）`;
      },
    ),
  ];

  // 只读工具可以并行执行；写操作串行 + 审批
  const readOnlyNames = new Set([
    'read_file',
    'read_artifact',
    'list_dir',
    'search_files',
    'glob',
    'git_status',
    'git_diff',
  ]);
  for (const item of tools) {
    if (readOnlyNames.has(item.definition.function.name)) {
      item.readOnly = true;
    }
  }
  return tools;
}

/** 工作区里有哪些目录（给 prompt 用） */
export function workspaceSummary(rootsInput: WorkspaceRootsInput): string {
  const roots = normalizeRoots(rootsInput);
  const allFiles = collectWorkspaceFiles(roots);
  return roots
    .map((root) => {
      try {
        if (!existsSync(root.path)) {
          return `【${root.name}】${root.path}（不存在）`;
        }
        const prefix = `${root.name}/`;
        const files = allFiles
          .filter((file) => file.rel.startsWith(prefix))
          .slice(0, 200)
          .map((file) => `  ${file.rel}`)
          .join('\n');
        return `【${root.name}】${root.path}\n${listDir(root.path)}\n文件（最多 200 个）：\n${files}`;
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

/**
 * 撤销一轮文件改动（checkpoint/undo）：
 * 按相反顺序恢复 before 内容、删除新建文件、把重命名移回去。
 * 越界路径或 IO 失败会记入 failed，不中断其余恢复。
 */
export function restoreChanges(
  rootsInput: WorkspaceRootsInput,
  changes: FileChange[],
): { restored: string[]; failed: string[] } {
  const roots = normalizeRoots(rootsInput);
  const restored: string[] = [];
  const failed: string[] = [];

  const absolute = (relativePath: string): string =>
    resolveInRoots(roots, relativePath);

  const write = (abs: string, content?: string) => {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content ?? '', 'utf8');
  };

  const remove = (abs: string) => {
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      rmSync(abs, { recursive: true, force: true });
    } else {
      rmSync(abs, { force: true });
    }
  };

  for (const change of [...changes].reverse()) {
    try {
      if (change.kind === 'created') {
        remove(absolute(change.path));
        restored.push(change.path);
      } else if (change.kind === 'modified' || change.kind === 'deleted') {
        write(absolute(change.path), change.before);
        restored.push(change.path);
      } else if (change.kind === 'renamed') {
        const from = change.from ? absolute(change.from) : undefined;
        const to = absolute(change.path);
        if (from && change.before === undefined) {
          // 二进制/不可读文件没有 before：能移回就移回，避免写空内容
          if (existsSync(to)) {
            mkdirSync(dirname(from), { recursive: true });
            renameSync(to, from);
          }
        } else if (from) {
          write(from, change.before);
        }
        remove(to);
        restored.push(`${change.from ?? ''} → ${change.path}`);
      }
    } catch (error: any) {
      failed.push(`${change.path}: ${error?.message ?? String(error)}`);
    }
  }

  return { restored, failed };
}

/** 审批预览：根据工具入参算出 before/after，供 UI 展示 diff */
export interface ApprovalPreview {
  kind: 'create' | 'modify' | 'delete' | 'rename' | 'command';
  path?: string;
  from?: string;
  before?: string;
  after?: string;
  command?: string;
}

export function previewApproval(
  rootsInput: WorkspaceRootsInput,
  toolName: string,
  args: Record<string, unknown>,
): ApprovalPreview[] {
  const roots = normalizeRoots(rootsInput);
  const abs = (relativePath: string) => resolveInRoots(roots, relativePath);
  const read = (relativePath: string): string | undefined => {
    const target = abs(relativePath);
    return existsSync(target) ? tryReadText(target) : undefined;
  };
  const str = (value: unknown): string =>
    typeof value === 'string' ? value : '';

  if (toolName === 'write_file') {
    const path = str(args.path);
    return [
      {
        kind: existsSync(abs(path)) ? 'modify' : 'create',
        path,
        before: read(path),
        after: str(args.content),
      },
    ];
  }

  if (toolName === 'edit_file') {
    const path = str(args.path);
    const before = read(path) ?? '';
    const next = before.split(str(args.old_string)).join(str(args.new_string));
    return [{ kind: 'modify', path, before, after: next }];
  }

  if (toolName === 'apply_patch') {
    const edits = Array.isArray(args.edits) ? (args.edits as any[]) : [];
    return edits.map((edit) => {
      const path = str(edit?.path);
      if (typeof edit?.content === 'string') {
        return {
          kind: existsSync(abs(path)) ? 'modify' : 'create',
          path,
          before: read(path),
          after: edit.content,
        } as ApprovalPreview;
      }
      const before = read(path) ?? '';
      const next = before.split(str(edit?.old_string)).join(str(edit?.new_string));
      return { kind: 'modify', path, before, after: next } as ApprovalPreview;
    });
  }

  if (toolName === 'delete_file') {
    const path = str(args.path);
    return [{ kind: 'delete', path, before: read(path), after: '' }];
  }

  if (toolName === 'move_file') {
    const from = str(args.from);
    const to = str(args.to);
    return [
      { kind: 'rename', path: to, from, before: read(from), after: read(to) },
    ];
  }

  if (toolName === 'run_terminal') {
    return [{ kind: 'command', command: str(args.command) }];
  }

  if (toolName === 'http_request') {
    const method = str(args.method) || 'GET';
    const url = str(args.url);
    const body = str(args.body);
    return [
      {
        kind: 'command',
        command: `${method.toUpperCase()} ${url}${body ? `\n\n${body}` : ''}`,
      },
    ];
  }

  return [];
}
