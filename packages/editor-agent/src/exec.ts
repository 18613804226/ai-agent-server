import { exec, execFile } from 'child_process';
import { promisify } from 'util';

export const execAsync = promisify(exec);
export const execFileAsync = promisify(execFile);

/**
 * 解码子进程输出。
 *
 * Windows 控制台程序（cmd 自身报错、部分 git 输出）默认按系统 ANSI 代码页输出，
 * 中文环境是 GBK；Node 的 exec 默认按 UTF-8 解码，中文会变成乱码。
 * 这里先严格按 UTF-8 解，失败再按 GBK 解（仅 Windows），
 * 这样 git / npm / node 的 UTF-8 输出不受影响。
 */
export function decodeProcOutput(
  stdout?: Buffer | string | null,
  stderr?: Buffer | string | null,
): string {
  return `${decodeBuffer(stdout)}${decodeBuffer(stderr)}`;
}

function decodeBuffer(buf?: Buffer | string | null): string {
  if (!buf) return '';
  if (typeof buf === 'string') return buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    if (process.platform === 'win32') {
      try {
        return new TextDecoder('gbk').decode(buf);
      } catch {
        // ICU 不可用时退回 UTF-8 替换解码，至少不丢内容
      }
    }
    return buf.toString('utf8');
  }
}
