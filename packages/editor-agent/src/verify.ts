import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifyHook } from '@repo/agent-orchestrator';
import { normalizeRoots, type WorkspaceRootsInput } from './tools.js';

const execAsync = promisify(exec);

export const DEFAULT_VERIFY_SCRIPTS = ['typecheck', 'lint'];

export interface VerifyOptions {
  /** 要运行的 npm scripts，按顺序 */
  scripts?: string[];
  /** 单个 script 的超时 */
  timeoutMs?: number;
  /** 单个失败输出最多保留多少字符 */
  maxOutputChars?: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（输出已截断）`;
}

export interface Diagnostic {
  file: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source?: string;
}

const MAX_DIAGNOSTICS = 100;

function normalizeSeverity(value: string): Diagnostic['severity'] {
  const lower = value.toLowerCase();
  if (lower.includes('error') || lower.includes('fatal')) return 'error';
  if (lower.includes('warn')) return 'warning';
  return 'info';
}

/**
 * 解析常见 lint / tsc 输出为结构化诊断：
 * - TypeScript: src/a.ts(12,5): error TS2322: ...
 * - ESLint stylish: 文件行 + 缩进的 12:5  error  ...
 * - ESLint JSON / tsc JSON
 */
export function parseDiagnostics(
  output: string,
  source = '',
): Diagnostic[] {
  const text = output.trim();
  if (!text) return [];

  // JSON 输出（ESLint --format json / tsc --pretty false 等）
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed)
        ? parsed.flatMap((item) =>
            (item?.messages ?? item?.errors ?? []).map((message: any) => ({
              ...message,
              filePath: item?.filePath ?? item?.file ?? item?.fileName,
            })),
          )
        : parsed?.messages ?? parsed?.errors ?? [];
      const result: Diagnostic[] = [];
      for (const item of list) {
        const file =
          item?.filePath ?? item?.file ?? item?.fileName ?? item?.source ?? '';
        if (!file) continue;
        const rawSeverity = item?.severity;
        const severity =
          typeof rawSeverity === 'number'
            ? rawSeverity >= 2
              ? ('error' as const)
              : rawSeverity === 1
                ? ('warning' as const)
                : ('info' as const)
            : normalizeSeverity(String(rawSeverity ?? 'error'));
        result.push({
          file: String(file),
          line: item?.line ?? item?.startLine ?? undefined,
          column: item?.column ?? item?.startColumn ?? undefined,
          severity,
          message: String(item?.message ?? item?.text ?? '').trim(),
          source: item?.ruleId ? String(item.ruleId) : source || undefined,
        });
      }
      return dedupeDiagnostics(result).slice(0, MAX_DIAGNOSTICS);
    } catch {
      // 不是合法 JSON，继续按文本解析
    }
  }

  const result: Diagnostic[] = [];
  let currentFile = '';

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // TypeScript: file(line,col): error TSxxxx: message
    const tsMatch = line.match(
      /^(.*?)\((\d+),(\d+)\):\s*(error|warning|info)\s*(TS\d+)?:\s*(.*)$/,
    );
    if (tsMatch) {
      const code = tsMatch[5] ? `${tsMatch[5]}: ` : '';
      result.push({
        file: tsMatch[1].trim(),
        line: Number(tsMatch[2]),
        column: Number(tsMatch[3]),
        severity: normalizeSeverity(tsMatch[4]),
        message: `${code}${tsMatch[6].trim()}`,
        source: 'tsc',
      });
      continue;
    }

    // ESLint stylish: 缩进的 "12:5  error  message"
    const eslintMatch = line.match(
      /^\s+(\d+):(\d+)\s+(error|warning|info|problem)\s+(.*)$/,
    );
    if (eslintMatch && currentFile) {
      result.push({
        file: currentFile,
        line: Number(eslintMatch[1]),
        column: Number(eslintMatch[2]),
        severity: normalizeSeverity(eslintMatch[3]),
        message: eslintMatch[4].trim(),
        source: 'eslint',
      });
      continue;
    }

    // 通用: file:line:col: error message
    const genericMatch = line.match(
      /^(.*?):(\d+)(?::(\d+))?\s*[:-]\s*(error|warning|info)\b\s*:?\s*(.*)$/i,
    );
    if (genericMatch) {
      result.push({
        file: genericMatch[1].trim(),
        line: Number(genericMatch[2]),
        column: genericMatch[3] ? Number(genericMatch[3]) : undefined,
        severity: normalizeSeverity(genericMatch[4]),
        message: genericMatch[5].trim(),
        source: source || undefined,
      });
      continue;
    }

    // 可能是文件路径行（ESLint stylish）
    if (/^[^\s].*\.(ts|tsx|js|jsx|mjs|cjs|json|vue|svelte|css|scss|less|html|md)$/.test(line)) {
      currentFile = line.trim();
    }
  }

  return dedupeDiagnostics(result).slice(0, MAX_DIAGNOSTICS);
}

function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const item of items) {
    const key = `${item.file}:${item.line ?? ''}:${item.column ?? ''}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (!diagnostics.length) return '';
  return [
    `诊断（${diagnostics.length} 条）：`,
    ...diagnostics.map(
      (item) =>
        `- ${item.file}:${item.line ?? '?'}:${item.column ?? '?'} [${item.severity}]${item.source ? ` ${item.source}` : ''} ${item.message}`,
    ),
  ].join('\n');
}

/** 从 package.json 里挑出可执行的验证脚本；纯函数，便于测试 */
export function pickVerifyScripts(
  packageJson: { scripts?: Record<string, string> } | null,
  scripts: string[] = DEFAULT_VERIFY_SCRIPTS,
): string[] {
  if (!packageJson?.scripts) return [];
  return scripts.filter((script) => typeof packageJson.scripts![script] === 'string');
}

/**
 * 创建编辑器工作区的自动验证器：
 * 找到 package.json 的 typecheck / lint 脚本并执行，返回结构化结果。
 * 没有可用脚本时返回 null（编排器据此跳过验证）。
 */
export function createVerifier(
  rootsInput: WorkspaceRootsInput,
  options: VerifyOptions = {},
): VerifyHook {
  const roots = normalizeRoots(rootsInput);
  const scriptsOption = options.scripts ?? DEFAULT_VERIFY_SCRIPTS;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputChars = options.maxOutputChars ?? 3000;

  return async ({ signal, scripts }) => {
    const activeScripts = scripts ?? scriptsOption;
    const results: string[] = [];
    let ranAny = false;

    for (const root of roots) {
      if (signal?.aborted) return null;

      const packageJsonPath = join(root.path, 'package.json');
      if (!existsSync(packageJsonPath)) continue;

      let packageJson: { scripts?: Record<string, string> } | null = null;
      try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      } catch {
        continue;
      }

      const available = pickVerifyScripts(packageJson, activeScripts);
      for (const script of available) {
        if (signal?.aborted) return null;
        ranAny = true;
        try {
          await execAsync(`npm run ${script}`, {
            cwd: root.path,
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            signal: signal as any,
          });
          results.push(`✅ ${root.name} npm run ${script} 通过`);
        } catch (error: any) {
          const output = `${error.stdout || ''}${error.stderr || ''}`.trim();
          const diagnostics = parseDiagnostics(output, script);
          if (diagnostics.length) {
            results.push(
              `❌ ${root.name} npm run ${script} 失败：\n${formatDiagnostics(diagnostics)}`,
            );
          } else {
            results.push(
              `❌ ${root.name} npm run ${script} 失败：\n${truncate(
                output || error?.message || '命令执行失败',
                maxOutputChars,
              )}`,
            );
          }
          break;
        }
      }
    }

    if (!ranAny) return null;
    return results.join('\n\n');
  };
}
