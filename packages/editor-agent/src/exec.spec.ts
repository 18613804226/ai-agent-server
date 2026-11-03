import { describe, expect, it } from 'vitest';
import { decodeProcOutput } from './exec.js';

describe('decodeProcOutput', () => {
  it('直接透传字符串', () => {
    expect(decodeProcOutput('abc', 'def')).toBe('abcdef');
    expect(decodeProcOutput(undefined, undefined)).toBe('');
    expect(decodeProcOutput(null, null)).toBe('');
  });

  it('按 UTF-8 解码合法字节', () => {
    const buf = Buffer.from('中文输出\nok', 'utf8');
    expect(decodeProcOutput(buf)).toBe('中文输出\nok');
  });

  it('非法 UTF-8 时回退 GBK（Windows）', () => {
    // “不是内部或外部命令”的 GBK 字节（cmd 在中文 Windows 下的报错）
    const gbk = Buffer.from('b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1ee', 'hex');
    if (process.platform !== 'win32') {
      expect(decodeProcOutput(gbk)).not.toBe('不是内部或外部命令');
      return;
    }
    expect(decodeProcOutput(gbk)).toBe('不是内部或外部命令');
  });
});
