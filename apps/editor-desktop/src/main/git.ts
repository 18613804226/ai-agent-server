import { execFile } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import type {
  GitChangeEntry,
  GitDiffResult,
  GitStatusResult,
} from '../shared/git.js';

const execFileAsync = promisify(execFile);
const MAX_PATCH_CHARS = 200_000;
/** 未跟踪文件超过这个大小就不生成 patch，避免卡住 IPC/渲染 */
const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function inside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

/** git 仓库相对路径 → 工作区路径（rootName/rel 或 rel） */
function toWorkspacePath(
  repoRoot: string,
  gitPath: string,
  roots: string[],
): string {
  const abs = resolve(repoRoot, gitPath);
  for (let i = 0; i < roots.length; i++) {
    const root = resolve(roots[i]);
    if (!inside(root, abs)) continue;
    const rel = normalize(relative(root, abs));
    if (!rel || rel.startsWith('..')) return gitPath;
    return i === 0 ? rel : `${basename(root)}/${rel}`;
  }
  return gitPath;
}

function kindOf(
  index: string,
  worktree: string,
): GitChangeEntry['kind'] {
  if (index === '?') return 'untracked';
  const pair = `${index}${worktree}`;
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(pair)) {
    return 'conflicted';
  }
  if (index === 'R' || worktree === 'R') return 'renamed';
  if (index === 'A') return 'added';
  if (index === 'D' || worktree === 'D') return 'deleted';
  return 'modified';
}

async function repoRootOf(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
    );
    const value = stdout.trim();
    return value ? resolve(value) : null;
  } catch {
    return null;
  }
}

async function repoRootFor(roots: string[]): Promise<string | null> {
  for (const root of roots) {
    const repoRoot = await repoRootOf(root);
    if (repoRoot) return repoRoot;
  }
  return null;
}

/** 读取工作区 git 状态（主工作区所在的仓库） */
export async function gitStatus(roots: string[]): Promise<GitStatusResult> {
  if (!roots.length) {
    return { available: false, entries: [], message: '还没有打开文件夹' };
  }
  const repoRoot = await repoRootFor(roots);
  if (!repoRoot) {
    return { available: false, entries: [], message: '当前工作区不是 git 仓库' };
  }
  try {
    const [status, branch] = await Promise.all([
      execFileAsync(
        'git',
        ['-C', repoRoot, 'status', '--porcelain=v1', '-z', '-uall'],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      ),
      execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      }).catch(() => ({ stdout: '' })),
    ]);

    const chunks = status.stdout.split('\0');
    const entries: GitChangeEntry[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      // 格式：XY PATH；重命名/复制时下一个 chunk 是原路径
      const index = chunk[0] ?? ' ';
      const worktree = chunk[1] ?? ' ';
      const gitPath = normalize(chunk.slice(3));
      if (!gitPath) continue;
      let origPath: string | undefined;
      if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
        origPath = normalize(chunks[++i] ?? '');
      }
      // 工作区可能只是仓库的一个子目录：面板只展示 roots 内的文件
      const abs = resolve(repoRoot, gitPath);
      if (!roots.some((root) => inside(resolve(root), abs))) continue;
      entries.push({
        gitPath,
        path: toWorkspacePath(repoRoot, gitPath, roots),
        origPath: origPath || undefined,
        index,
        worktree,
        staged: index !== ' ' && index !== '?',
        untracked: index === '?',
        kind: kindOf(index, worktree),
      });
    }
    return {
      available: true,
      repoRoot: normalize(repoRoot),
      branch: branch.stdout.trim() || undefined,
      entries,
    };
  } catch (e: any) {
    return {
      available: false,
      entries: [],
      message: e?.message || String(e),
    };
  }
}

function addedFilePatch(repoRoot: string, gitPath: string): string {
  const abs = resolve(repoRoot, gitPath);
  if (!existsSync(abs)) return `（文件不存在：${gitPath}）`;
  try {
    if (statSync(abs).size > MAX_UNTRACKED_FILE_BYTES) {
      return `（文件过大（>512KB），不显示 diff：${gitPath}）`;
    }
  } catch {
    return `（无法读取文件：${gitPath}）`;
  }
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return `（无法读取文件：${gitPath}）`;
  }
  if (text.includes('\0')) return `（二进制文件，无法显示 diff：${gitPath}）`;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

/** 读取单个文件的 diff（staged = 暂存区 vs HEAD；untracked = 全文按新增显示） */
export async function gitDiff(
  roots: string[],
  input: { gitPath: string; staged?: boolean; untracked?: boolean },
): Promise<GitDiffResult> {
  const gitPath = normalize(String(input.gitPath ?? ''));
  if (!gitPath) return { patch: '', message: '缺少文件路径' };
  const repoRoot = await repoRootFor(roots);
  if (!repoRoot) return { patch: '', message: '当前工作区不是 git 仓库' };
  if (input.untracked) {
    const abs = resolve(repoRoot, gitPath);
    // IPC 入参不可信：只允许读取工作区 roots 内的文件
    if (!roots.some((root) => inside(resolve(root), abs))) {
      return { patch: '', message: `路径不在工作区内：${gitPath}` };
    }
    const patch = addedFilePatch(repoRoot, gitPath);
    return {
      patch:
        patch.length > MAX_PATCH_CHARS
          ? `${patch.slice(0, MAX_PATCH_CHARS)}\n…（diff 过长，已截断）`
          : patch,
    };
  }
  try {
    const args = ['-C', repoRoot, 'diff'];
    if (input.staged) args.push('--cached');
    args.push('--', gitPath);
    const { stdout } = await execFileAsync('git', args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    const patch =
      stdout.length > MAX_PATCH_CHARS
        ? `${stdout.slice(0, MAX_PATCH_CHARS)}\n…（diff 过长，已截断）`
        : stdout;
    return { patch };
  } catch (e: any) {
    return { patch: '', message: e?.message || String(e) };
  }
}
