import type {
  RegisteredTool,
  ToolDefinition,
  ToolHandler,
} from '@repo/agent-orchestrator';

/** 数据库列结构 */
export interface DatabaseSchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

/** 数据库表结构 */
export interface DatabaseSchemaTable {
  name: string;
  columns: DatabaseSchemaColumn[];
}

/** 数据库整体结构 */
export interface DatabaseSchema {
  tables: DatabaseSchemaTable[];
}

/**
 * 数据库执行器：由宿主（Electron 主进程）实现并注入。
 * 共享包只依赖这个接口，不直接依赖 pg / mysql2 / node:sqlite。
 */
export interface DatabaseRunner {
  /** 是否已配置可用连接 */
  isConfigured(): boolean;
  /** 只读查询，返回行 */
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  /** 写操作，返回受影响行数 */
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected?: number }>;
  /** 表结构 */
  schema(): Promise<DatabaseSchema>;
}

const MAX_ROWS = 200;
const MAX_CHARS = 4000;

const NOT_CONFIGURED =
  '当前没有配置数据库连接。请在「设置 → 数据库」里添加并启用一个连接。';

function truncateText(s: string): string {
  return s.length > MAX_CHARS
    ? `${s.slice(0, MAX_CHARS)}\n…（结果过长，已截断）`
    : s;
}

function formatRows(rows: unknown[]): string {
  if (!rows.length) return '（无结果）';
  const limited = rows.slice(0, MAX_ROWS);
  const text = limited
    .map((r) => (typeof r === 'object' ? JSON.stringify(r) : String(r)))
    .join('\n');
  const suffix =
    rows.length > MAX_ROWS
      ? `\n…（共 ${rows.length} 行，仅显示前 ${MAX_ROWS} 行）`
      : '';
  return truncateText(text + suffix);
}

/** 去掉注释后判断是否为只读语句（单语句、非 EXPLAIN ANALYZE、WITH 无写操作） */
export function isReadOnlySql(sql: string): boolean {
  const cleaned = sql
    .trim()
    .toLowerCase()
    .replace(/^--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  // 只允许单条语句：去掉结尾分号后不应再出现分号
  const trimmed = cleaned.replace(/;+\s*$/, '').trim();
  if (!trimmed || trimmed.includes(';')) return false;
  // EXPLAIN ANALYZE 会实际执行语句，禁止；普通 EXPLAIN 只解释不执行，允许
  if (/^explain\b/.test(trimmed) && /\banalyze\b/.test(trimmed)) return false;
  // WITH ... INSERT/UPDATE/DELETE/MERGE 会写数据，禁止
  if (
    /^with\b/.test(trimmed) &&
    /\b(insert|update|delete|merge)\b/.test(trimmed)
  ) {
    return false;
  }
  return /^(select|with|explain|show|describe|desc)\b/.test(trimmed);
}

function tool(
  definition: ToolDefinition,
  handler: ToolHandler,
  readOnly = false,
): RegisteredTool {
  return {
    definition,
    readOnly: readOnly || undefined,
    handler: async (args, context) => {
      try {
        return await handler(args, context);
      } catch (e: any) {
        return `数据库工具执行出错：${e?.message ?? '未知错误'}`;
      }
    },
  };
}

/**
 * 数据库工具集：describe_database / query_database / execute_sql。
 * database 为空时工具仍注册（模型可见），但执行会提示未配置。
 */
export function createDatabaseTools(database?: DatabaseRunner): RegisteredTool[] {
  return [
    tool(
      {
        type: 'function',
        function: {
          name: 'describe_database',
          description:
            '查看当前数据库的表结构（表名、列名、类型、主键）。修改数据前先调用它了解结构。',
          parameters: { type: 'object', properties: {} },
        },
      },
      async () => {
        if (!database?.isConfigured()) return NOT_CONFIGURED;
        const schema = await database.schema();
        if (!schema.tables.length) return '数据库里没有表。';
        const lines = schema.tables.map((t) => {
          const cols = t.columns
            .map((c) => `${c.name}${c.primaryKey ? ' (PK)' : ''}: ${c.type}`)
            .join(', ');
          return `${t.name}(${cols})`;
        });
        return truncateText(lines.join('\n'));
      },
      true,
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'query_database',
          description:
            '执行只读 SQL 查询（SELECT / WITH / EXPLAIN / SHOW），返回结果行。',
          parameters: {
            type: 'object',
            properties: {
              sql: { type: 'string', description: '只读 SQL 语句' },
            },
            required: ['sql'],
          },
        },
      },
      async (args) => {
        if (!database?.isConfigured()) return NOT_CONFIGURED;
        const sql = String(args.sql ?? '').trim();
        if (!sql) return 'sql 不能为空';
        if (!isReadOnlySql(sql)) {
          return 'query_database 只允许只读 SQL（SELECT/WITH/EXPLAIN/SHOW），写操作请用 execute_sql。';
        }
        const rows = await database.query(sql);
        return formatRows(rows);
      },
      true,
    ),
    tool(
      {
        type: 'function',
        function: {
          name: 'execute_sql',
          description:
            '执行写 SQL（INSERT / UPDATE / DELETE / DDL），返回受影响行数。执行前会请求用户确认。',
          parameters: {
            type: 'object',
            properties: {
              sql: { type: 'string', description: '要执行的写 SQL 语句' },
            },
            required: ['sql'],
          },
        },
      },
      async (args) => {
        if (!database?.isConfigured()) return NOT_CONFIGURED;
        const sql = String(args.sql ?? '').trim();
        if (!sql) return 'sql 不能为空';
        if (isReadOnlySql(sql)) {
          return 'execute_sql 用于写操作；查询请用 query_database。';
        }
        const result = await database.execute(sql);
        return `执行成功，受影响行数：${result.rowsAffected ?? '未知'}`;
      },
    ),
  ];
}
