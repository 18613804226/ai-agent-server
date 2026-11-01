import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VERIFY_SCRIPTS,
  parseDiagnostics,
  pickVerifyScripts,
} from './verify.js';
import { buildEditorSystemPrompt } from './prompt.js';
import { createEditorAgent } from './agent.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('pickVerifyScripts', () => {
  it('按顺序挑出存在的脚本', () => {
    expect(
      pickVerifyScripts({
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' },
      }),
    ).toEqual(['typecheck', 'lint']);
  });

  it('跳过缺失的脚本', () => {
    expect(pickVerifyScripts({ scripts: { lint: 'eslint .' } })).toEqual([
      'lint',
    ]);
  });

  it('没有 package.json / scripts 时返回空', () => {
    expect(pickVerifyScripts(null)).toEqual([]);
    expect(pickVerifyScripts({})).toEqual([]);
  });

  it('默认脚本列表是 typecheck + lint', () => {
    expect(DEFAULT_VERIFY_SCRIPTS).toEqual(['typecheck', 'lint']);
  });
});

describe('parseDiagnostics', () => {
  it('解析 TypeScript 输出', () => {
    const result = parseDiagnostics(
      'src/a.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.\nsrc/a.ts(34,1): warning TS6133: x is declared but never read.',
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      file: 'src/a.ts',
      line: 12,
      column: 5,
      severity: 'error',
      message: expect.stringContaining('TS2322'),
    });
    expect(result[1].severity).toBe('warning');
  });

  it('解析 ESLint stylish 输出', () => {
    const result = parseDiagnostics(
      'src/b.ts\n  10:5  error  Unexpected any  @typescript-eslint/no-explicit-any\n  20:1  warning  Missing semicolon  semi',
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      file: 'src/b.ts',
      line: 10,
      column: 5,
      severity: 'error',
      message: expect.stringContaining('no-explicit-any'),
    });
  });

  it('解析 ESLint JSON 输出', () => {
    const json = JSON.stringify([
      {
        filePath: 'src/c.ts',
        messages: [
          {
            line: 3,
            column: 1,
            severity: 2,
            message: 'Unexpected console statement.',
            ruleId: 'no-console',
          },
        ],
      },
    ]);
    const result = parseDiagnostics(json);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      file: 'src/c.ts',
      line: 3,
      column: 1,
      severity: 'error',
      message: expect.stringContaining('console'),
    });
  });

  it('解析通用 file:line:col: error 格式', () => {
    const result = parseDiagnostics('src/d.ts:8:2: error: something broke');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      file: 'src/d.ts',
      line: 8,
      column: 2,
      severity: 'error',
      message: 'something broke',
    });
  });

  it('空输出返回空数组', () => {
    expect(parseDiagnostics('')).toEqual([]);
  });
});

describe('buildEditorSystemPrompt', () => {
  it('注入编辑器上下文（当前文件 / 选区）', () => {
    const prompt = buildEditorSystemPrompt(
      'some-root',
      '摘要',
      { activeFile: 'a.ts', selection: 'const x = 1;' },
    );
    expect(prompt).toContain('当前文件：a.ts');
    expect(prompt).toContain('const x = 1;');
    expect(prompt).toContain('verify_workspace');
  });
});

describe('verify_workspace 工具', () => {
  it('支持 scripts 覆盖', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-scripts-'));
    try {
      const calls: Array<{ toolNames: string[]; scripts?: string[] }> = [];
      const agent = createEditorAgent(root, undefined, {
        verifier: async (context) => {
          calls.push({
            toolNames: context.toolNames,
            scripts: context.scripts,
          });
          return 'ok';
        },
      });
      const tool = agent.tools.find(
        (t) => t.definition.function.name === 'verify_workspace',
      )!;
      await tool.handler(
        { scripts: ['test'] },
        { toolName: 'verify_workspace' },
      );
      expect(calls[0].scripts).toEqual(['test']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
