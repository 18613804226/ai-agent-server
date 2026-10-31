import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildWorkspaceTree,
  createEditorTools,
  readWorkspaceFile,
} from './tools.js';
import { createEditorAgent } from './agent.js';

let root: string;
let tools: ReturnType<typeof createEditorTools>;

const tool = (name: string) =>
  tools.find((t) => t.definition.function.name === name)!;
const run = async (name: string, args: Record<string, unknown> = {}) =>
  await tool(name).handler(args);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'editor-agent-'));
  tools = createEditorTools(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createEditorTools', () => {
  it('注册完整工具集', () => {
    expect(tools.map((t) => t.definition.function.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'apply_patch',
      'delete_file',
      'move_file',
      'create_directory',
      'list_dir',
      'search_files',
      'glob',
      'run_terminal',
      'git_status',
      'git_diff',
    ]);
  });

  it('读写文件', async () => {
    await run('write_file', { path: 'src/a.ts', content: 'export const a = 1;' });
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe(
      'export const a = 1;',
    );
    expect(await run('read_file', { path: 'src/a.ts' })).toContain('a = 1');
  });

  it('edit_file 局部替换', async () => {
    writeFileSync(join(root, 'a.txt'), 'foo foo', 'utf8');
    const out = await run('edit_file', {
      path: 'a.txt',
      old_string: 'foo',
      new_string: 'bar',
    });
    expect(out).toContain('替换 2 处');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('bar bar');
  });

  it('apply_patch 一次改多个文件', async () => {
    writeFileSync(join(root, 'a.txt'), 'A', 'utf8');
    writeFileSync(join(root, 'b.txt'), 'B', 'utf8');
    const out = await run('apply_patch', {
      edits: [
        { path: 'a.txt', old_string: 'A', new_string: 'AA' },
        { path: 'b.txt', content: 'BB' },
      ],
    });
    expect(out).toContain('已应用 2 个修改');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('AA');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('BB');
  });

  it('apply_patch 任一 old_string 缺失则整批不应用', async () => {
    writeFileSync(join(root, 'a.txt'), 'A', 'utf8');
    const out = await run('apply_patch', {
      edits: [
        { path: 'a.txt', old_string: 'A', new_string: 'AA' },
        { path: 'a.txt', old_string: 'NOT_FOUND', new_string: 'x' },
      ],
    });
    expect(out).toContain('整批未应用');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('A');
  });

  it('create_directory / move_file / delete_file', async () => {
    await run('create_directory', { path: 'nested/dir' });
    expect(existsSync(join(root, 'nested/dir'))).toBe(true);

    writeFileSync(join(root, 'x.txt'), 'x', 'utf8');
    await run('move_file', { from: 'x.txt', to: 'nested/dir/y.txt' });
    expect(existsSync(join(root, 'x.txt'))).toBe(false);
    expect(existsSync(join(root, 'nested/dir/y.txt'))).toBe(true);

    await run('delete_file', { path: 'nested/dir/y.txt' });
    expect(existsSync(join(root, 'nested/dir/y.txt'))).toBe(false);
  });

  it('glob 按模式找文件', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), '', 'utf8');
    writeFileSync(join(root, 'src/b.tsx'), '', 'utf8');
    writeFileSync(join(root, 'c.md'), '', 'utf8');

    const ts = await run('glob', { pattern: '**/*.ts' });
    expect(ts).toContain('src/a.ts');
    expect(ts).not.toContain('src/b.tsx');

    const both = await run('glob', { pattern: 'src/**/*.{ts,tsx}' });
    expect(both).toContain('src/a.ts');
    expect(both).toContain('src/b.tsx');
  });

  it('拒绝越界路径', async () => {
    const out = await run('read_file', { path: '../../etc/passwd' });
    expect(out).toContain('越界');
  });

  it('拒绝破坏性终端命令', async () => {
    const out = await run('run_terminal', { command: 'rm -rf /' });
    expect(out).toContain('拒绝');
  });
});

describe('文件改动回调', () => {
  it('记录 created / modified / renamed / deleted', async () => {
    const changes: any[] = [];
    tools = createEditorTools(root, (c) => changes.push(c));

    await run('write_file', { path: 'a.txt', content: 'A' });
    expect(changes.at(-1)).toMatchObject({
      path: 'a.txt',
      kind: 'created',
      after: 'A',
    });

    await run('edit_file', {
      path: 'a.txt',
      old_string: 'A',
      new_string: 'AA',
    });
    expect(changes.at(-1)).toMatchObject({
      path: 'a.txt',
      kind: 'modified',
      before: 'A',
      after: 'AA',
    });

    await run('move_file', { from: 'a.txt', to: 'b.txt' });
    expect(changes.at(-1)).toMatchObject({
      path: 'b.txt',
      kind: 'renamed',
      from: 'a.txt',
    });

    await run('delete_file', { path: 'b.txt' });
    expect(changes.at(-1)).toMatchObject({
      path: 'b.txt',
      kind: 'deleted',
      before: 'AA',
    });
  });

  it('apply_patch 每个文件都回调', async () => {
    writeFileSync(join(root, 'a.txt'), 'A', 'utf8');
    writeFileSync(join(root, 'b.txt'), 'B', 'utf8');
    const changes: any[] = [];
    tools = createEditorTools(root, (c) => changes.push(c));
    await run('apply_patch', {
      edits: [
        { path: 'a.txt', old_string: 'A', new_string: 'AA' },
        { path: 'b.txt', content: 'BB' },
      ],
    });
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.kind)).toEqual(['modified', 'modified']);
    expect(changes[0]).toMatchObject({ path: 'a.txt', before: 'A', after: 'AA' });
    expect(changes[1]).toMatchObject({ path: 'b.txt', before: 'B', after: 'BB' });
  });
});

describe('workspace helpers', () => {
  it('buildWorkspaceTree 返回目录树（根节点 + 子节点）', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), '', 'utf8');
    const tree = buildWorkspaceTree(root);
    expect(tree).toHaveLength(1);
    expect(
      tree[0].children?.some((n) => n.name === 'src' && n.type === 'dir'),
    ).toBe(true);
  });

  it('readWorkspaceFile 拒绝越界', () => {
    expect(() => readWorkspaceFile(root, '../x')).toThrow('越界');
  });
});

describe('多根工作区', () => {
  it('路径以根名前缀解析到对应文件夹', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'editor-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'editor-b-'));
    try {
      writeFileSync(join(rootA, 'a.txt'), 'A', 'utf8');
      writeFileSync(join(rootB, 'b.txt'), 'B', 'utf8');
      const roots = [
        { name: 'alpha', path: rootA },
        { name: 'beta', path: rootB },
      ];
      const multi = createEditorTools(roots);
      const read = multi.find(
        (t) => t.definition.function.name === 'read_file',
      )!;

      expect(await read.handler({ path: 'beta/b.txt' })).toBe('B');
      expect(await read.handler({ path: 'alpha/a.txt' })).toBe('A');

      const tree = buildWorkspaceTree(roots);
      expect(tree.map((n) => n.name)).toEqual(['alpha', 'beta']);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe('createEditorAgent', () => {
  it('返回绑定 root 的 editor 定义', () => {
    const agent = createEditorAgent(root);
    expect(agent.id).toBe('editor');
    expect(agent.tools).toHaveLength(13);
    expect(agent.buildSystemPrompt()).toContain(root);
  });
});
