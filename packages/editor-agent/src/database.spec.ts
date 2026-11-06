import { describe, expect, it, vi } from 'vitest';
import { createDatabaseTools, type DatabaseRunner } from './database.js';

function makeRunner(
  overrides: Partial<DatabaseRunner> = {},
): DatabaseRunner & {
  query: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  schema: ReturnType<typeof vi.fn>;
} {
  return {
    isConfigured: () => true,
    query: vi.fn().mockResolvedValue([{ id: 1, name: '张三' }]),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 3 }),
    schema: vi.fn().mockResolvedValue({
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
            { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          ],
        },
      ],
    }),
    ...overrides,
  };
}

function setup(overrides: Partial<DatabaseRunner> = {}) {
  const runner = makeRunner(overrides);
  const tools = createDatabaseTools(runner);
  const find = (name: string) =>
    tools.find((t) => t.definition.function.name === name)!;
  return { runner, tools, find };
}

describe('createDatabaseTools', () => {
  it('未配置时返回提示', async () => {
    const { find } = setup({ isConfigured: () => false });
    const res = await find('query_database').handler(
      { sql: 'SELECT 1' },
      { toolName: 'query_database' },
    );
    expect(res).toContain('没有配置');
  });

  it('query_database 拒绝写语句', async () => {
    const { runner, find } = setup();
    const res = await find('query_database').handler(
      { sql: 'DELETE FROM users' },
      { toolName: 'query_database' },
    );
    expect(res).toContain('只允许只读');
    expect(runner.query).not.toHaveBeenCalled();
  });

  it('query_database 拒绝多语句', async () => {
    const { runner, find } = setup();
    const res = await find('query_database').handler(
      { sql: 'SELECT 1; DROP TABLE users' },
      { toolName: 'query_database' },
    );
    expect(res).toContain('只允许只读');
    expect(runner.query).not.toHaveBeenCalled();
  });

  it('query_database 拒绝 EXPLAIN ANALYZE', async () => {
    const { runner, find } = setup();
    const res = await find('query_database').handler(
      { sql: 'EXPLAIN ANALYZE DELETE FROM users' },
      { toolName: 'query_database' },
    );
    expect(res).toContain('只允许只读');
    expect(runner.query).not.toHaveBeenCalled();
  });

  it('query_database 拒绝 WITH 写操作', async () => {
    const { runner, find } = setup();
    const res = await find('query_database').handler(
      { sql: 'WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d' },
      { toolName: 'query_database' },
    );
    expect(res).toContain('只允许只读');
    expect(runner.query).not.toHaveBeenCalled();
  });

  it('execute_sql 拒绝只读语句', async () => {
    const { runner, find } = setup();
    const res = await find('execute_sql').handler(
      { sql: 'SELECT * FROM users' },
      { toolName: 'execute_sql' },
    );
    expect(res).toContain('查询请用 query_database');
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it('describe_database 返回表结构', async () => {
    const { find } = setup();
    const res = await find('describe_database').handler(
      {},
      { toolName: 'describe_database' },
    );
    expect(res).toContain('users');
    expect(res).toContain('id');
    expect(res).toContain('PK');
  });

  it('query_database 返回结果行', async () => {
    const { runner, find } = setup();
    const res = await find('query_database').handler(
      { sql: 'SELECT * FROM users' },
      { toolName: 'query_database' },
    );
    expect(res).toContain('张三');
    expect(runner.query).toHaveBeenCalledWith('SELECT * FROM users');
  });

  it('execute_sql 返回受影响行数', async () => {
    const { runner, find } = setup();
    const res = await find('execute_sql').handler(
      { sql: 'UPDATE users SET name = "x"' },
      { toolName: 'execute_sql' },
    );
    expect(res).toContain('3');
    expect(runner.execute).toHaveBeenCalledWith(
      'UPDATE users SET name = "x"',
    );
  });

  it('只读工具标记为 readOnly', () => {
    const { tools } = setup();
    const readOnly = tools
      .filter((t) => t.readOnly)
      .map((t) => t.definition.function.name);
    expect(readOnly).toContain('query_database');
    expect(readOnly).toContain('describe_database');
    expect(readOnly).not.toContain('execute_sql');
  });
});
