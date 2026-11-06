import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Pool as PgPool } from 'pg';
import type { Pool as MysqlPool } from 'mysql2/promise';
import type { DatabaseSchema, DatabaseRunner } from '@repo/editor-agent';
import {
  DEMO_DB_ID,
  type DatabaseConfig,
  type DatabaseConnection,
  type DatabaseConnectionInput,
} from '../shared/database.js';

export type {
  DatabaseConnection,
  DatabaseConfig,
  DatabaseConnectionInput,
} from '../shared/database.js';

/** 默认演示库文件路径 */
function demoPath(): string {
  try {
    return join(app.getPath('userData'), 'demo.db');
  } catch {
    return 'demo.db';
  }
}

/** 默认演示连接：SQLite，落在 userData/demo.db */
function defaultDatabase(): DatabaseConfig {
  try {
    return {
      connections: [
        {
          id: DEMO_DB_ID,
          name: '演示数据库 (SQLite)',
          driver: 'sqlite',
          filename: demoPath(),
        },
      ],
      activeId: DEMO_DB_ID,
    };
  } catch {
    return { connections: [], activeId: '' };
  }
}

function storePath(): string {
  return join(app.getPath('userData'), 'database.json');
}

function loadDatabaseConfig(): DatabaseConfig {
  try {
    if (!existsSync(storePath())) return defaultDatabase();
    const raw = JSON.parse(readFileSync(storePath(), 'utf8'));
    if (!Array.isArray(raw?.connections)) return defaultDatabase();
    return {
      connections: raw.connections,
      activeId:
        typeof raw.activeId === 'string' ? raw.activeId : DEMO_DB_ID,
    };
  } catch {
    return defaultDatabase();
  }
}

function saveDatabaseConfig(config: DatabaseConfig): void {
  mkdirSync(dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify(config, null, 2), 'utf8');
}

/** 用 safeStorage 加密明文密码；不可用时返回 undefined */
function encryptSecret(plain: string): string | undefined {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.encryptString(plain).toString('base64');
  } catch {
    return undefined;
  }
}

/** 解密密码；失败返回 undefined */
function decryptSecret(enc: string | undefined): string | undefined {
  if (!enc) return undefined;
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return undefined;
  }
}

/** 驱动内部接口 */
interface Driver {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  /** 只读查询：驱动层强制只读，用于 AI 的 query_database */
  queryReadOnly(sql: string, params?: unknown[]): Promise<unknown[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected?: number }>;
  schema(): Promise<DatabaseSchema>;
  /** 按驱动方言引用标识符 */
  quoteIdent(name: string): string;
  close(): void;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 单条语句安全上限：只读工具强制 LIMIT，面板结果在此截断 */
const MAX_ROWS = 500;

/** 查询超时（毫秒），防止慢查询长期占用连接 */
const QUERY_TIMEOUT_MS = 10_000;

/** 给 SELECT/WITH 语句追加 LIMIT（已带 LIMIT 则不重复） */
function appendLimit(sql: string, limit: number): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (/\blimit\s+\d+\s*$/i.test(trimmed)) return trimmed;
  if (/^(select|with)\b/i.test(trimmed)) return `${trimmed} LIMIT ${limit}`;
  return trimmed;
}

/** SQLite：用 Electron 内置 node:sqlite，零外部依赖 */
class SqliteDriver implements Driver {
  constructor(private readonly db: DatabaseSync) {}

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as unknown[];
  }

  async queryReadOnly(
    sql: string,
    params: unknown[] = [],
  ): Promise<unknown[]> {
    // query_only 是连接级开关；SQLite 操作为同步，不会与其它操作交错
    this.db.exec('PRAGMA query_only = ON');
    try {
      return this.db.prepare(sql).all(...(params as SQLInputValue[])) as unknown[];
    } finally {
      this.db.exec('PRAGMA query_only = OFF');
    }
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowsAffected?: number }> {
    const info = this.db.prepare(sql).run(...(params as SQLInputValue[]));
    return { rowsAffected: Number(info.changes) };
  }

  async schema(): Promise<DatabaseSchema> {
    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    return {
      tables: tables.map((t) => {
        const cols = this.db
          .prepare(`PRAGMA table_info(${quoteIdent(t.name)})`)
          .all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>;
        return {
          name: t.name,
          columns: cols.map((c) => ({
            name: c.name,
            type: c.type || 'TEXT',
            nullable: !c.notnull,
            primaryKey: Boolean(c.pk),
          })),
        };
      }),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }

  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }
}

/** PostgreSQL：pg 动态加载，仅在配置 PG 连接时才依赖 */
class PostgresDriver implements Driver {
  constructor(private readonly pool: PgPool) {}

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    const res = await this.pool.query(sql, params);
    return res.rows;
  }

  async queryReadOnly(
    sql: string,
    params: unknown[] = [],
  ): Promise<unknown[]> {
    // 专用客户端 + 只读事务，防止 SELECT 夹带写操作
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const res = await client.query(sql, params);
      await client.query('COMMIT');
      return res.rows;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowsAffected?: number }> {
    const res = await this.pool.query(sql, params);
    return { rowsAffected: res.rowCount ?? undefined };
  }

  async schema(): Promise<DatabaseSchema> {
    const tables = await this.pool.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const result: DatabaseSchema = { tables: [] };
    for (const t of tables.rows) {
      const cols = await this.pool.query<{
        name: string;
        type: string;
        nullable: string;
      }>(
        `SELECT column_name AS name, data_type AS type, is_nullable AS nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [t.name],
      );
      const pk = await this.pool.query<{ name: string }>(
        `SELECT kcu.column_name AS name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = 'public' AND tc.table_name = $1`,
        [t.name],
      );
      const pkSet = new Set(pk.rows.map((r) => r.name));
      result.tables.push({
        name: t.name,
        columns: cols.rows.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable === 'YES',
          primaryKey: pkSet.has(c.name),
        })),
      });
    }
    return result;
  }

  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  close(): void {
    void this.pool.end().catch(() => {});
  }
}

/** MySQL：mysql2 动态加载 */
class MysqlDriver implements Driver {
  constructor(private readonly pool: MysqlPool) {}

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    const [rows] = await this.pool.query({
      sql,
      values: params,
      timeout: QUERY_TIMEOUT_MS,
    });
    return rows as unknown[];
  }

  async queryReadOnly(
    sql: string,
    params: unknown[] = [],
  ): Promise<unknown[]> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query('START TRANSACTION READ ONLY');
      const [rows] = await conn.query({
        sql,
        values: params,
        timeout: QUERY_TIMEOUT_MS,
      });
      await conn.query('COMMIT');
      return rows as unknown[];
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowsAffected?: number }> {
    const [res] = await this.pool.query({
      sql,
      values: params,
      timeout: QUERY_TIMEOUT_MS,
    });
    const info = res as { affectedRows?: number };
    return { rowsAffected: info.affectedRows };
  }

  async schema(): Promise<DatabaseSchema> {
    const [tables] = (await this.pool.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() ORDER BY table_name`,
    )) as unknown as Array<{ name: string }>[];
    const result: DatabaseSchema = { tables: [] };
    for (const t of tables) {
      const [cols] = (await this.pool.query(
        `SELECT column_name AS name, data_type AS type,
                is_nullable AS nullable, column_key AS key
         FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ?
         ORDER BY ordinal_position`,
        [t.name],
      )) as unknown as Array<{
        name: string;
        type: string;
        nullable: string;
        key: string;
      }>[];
      result.tables.push({
        name: t.name,
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable === 'YES',
          primaryKey: c.key === 'PRI',
        })),
      });
    }
    return result;
  }

  quoteIdent(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  close(): void {
    void this.pool.end().catch(() => {});
  }
}

async function createDriver(conn: DatabaseConnection): Promise<Driver> {
  if (conn.driver === 'sqlite') {
    const filename = conn.filename || ':memory:';
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    return new SqliteDriver(new DatabaseSync(filename));
  }
  if (conn.driver === 'postgres') {
    const { Pool } = await import('pg');
    const password = decryptSecret(conn.passwordEnc) ?? '';
    return new PostgresDriver(
      new Pool({
        host: conn.host,
        port: conn.port,
        database: conn.database,
        user: conn.user,
        password,
        // 默认校验服务端证书；自签证书需配置 CA
        ssl: conn.ssl ? {} : false,
        connectionTimeoutMillis: 10_000,
        query_timeout: QUERY_TIMEOUT_MS,
        statement_timeout: QUERY_TIMEOUT_MS,
        max: 5,
      }),
    );
  }
  if (conn.driver === 'mysql') {
    const { createPool } = await import('mysql2/promise');
    const password = decryptSecret(conn.passwordEnc) ?? '';
    return new MysqlDriver(
      createPool({
        host: conn.host,
        port: conn.port,
        database: conn.database,
        user: conn.user,
        password,
        // 默认校验服务端证书；自签证书需配置 CA
        ssl: conn.ssl ? {} : undefined,
        connectionLimit: 5,
        connectTimeout: 10_000,
      }),
    );
  }
  throw new Error(`不支持的数据库驱动：${conn.driver}`);
}

/** 演示数据：首次连接空库时自动写入 */
async function seedDemoDatabase(driver: Driver): Promise<void> {
  const schema = await driver.schema();
  if (schema.tables.length) return;

  await driver.execute(
    `CREATE TABLE users (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       email TEXT UNIQUE,
       created_at TEXT DEFAULT (datetime('now'))
     )`,
  );
  await driver.execute(
    `CREATE TABLE posts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id INTEGER NOT NULL REFERENCES users(id),
       title TEXT NOT NULL,
       body TEXT,
       published INTEGER DEFAULT 0
     )`,
  );
  await driver.execute(
    `CREATE TABLE products (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       price REAL NOT NULL DEFAULT 0,
       stock INTEGER NOT NULL DEFAULT 0
     )`,
  );
  await driver.execute(
    `INSERT INTO users (name, email) VALUES
       ('张三', 'zhangsan@example.com'),
       ('李四', 'lisi@example.com'),
       ('王五', 'wangwu@example.com')`,
  );
  await driver.execute(
    `INSERT INTO posts (user_id, title, body, published) VALUES
       (1, '第一篇', '你好，世界', 1),
       (1, '第二篇', 'SQLite 演示', 1),
       (2, '李四的文章', '测试内容', 0)`,
  );
  await driver.execute(
    `INSERT INTO products (name, price, stock) VALUES
       ('键盘', 199.0, 50),
       ('鼠标', 99.5, 120),
       ('显示器', 899.0, 15)`,
  );
}

/**
 * 数据库管理器（主进程单例）：
 * - 连接配置存在 userData/database.json，独立于 AppConfig
 * - 按活动连接懒加载驱动并缓存
 * - 供 AI 工具与数据库面板共用
 */
export class DatabaseManager {
  private driver: Driver | null = null;
  private driverConnId: string | null = null;
  private connecting: Promise<Driver> | null = null;
  private connectingConnId: string | null = null;

  activeConnection(): DatabaseConnection | null {
    const cfg = loadDatabaseConfig();
    return (
      cfg.connections.find((c) => c.id === cfg.activeId) ?? null
    );
  }

  /** 给渲染层的连接列表（不含密码） */
  listConfig(): DatabaseConfig {
    const cfg = loadDatabaseConfig();
    return {
      connections: cfg.connections.map((c) => {
        const { passwordEnc: _passwordEnc, ...rest } = c;
        return rest;
      }),
      activeId: cfg.activeId,
    };
  }

  saveConnection(input: DatabaseConnectionInput): DatabaseConfig {
    const cfg = loadDatabaseConfig();
    const connections = [...cfg.connections];
    const index = connections.findIndex((c) => c.id === input.id);
    const old = index >= 0 ? connections[index] : undefined;
    const toSave: DatabaseConnection = { ...input };
    const plain = input.password;
    if (plain) toSave.passwordEnc = encryptSecret(plain);
    delete (toSave as { password?: string }).password;
    // 没传新密码则沿用旧的加密密码
    if (!toSave.passwordEnc) toSave.passwordEnc = old?.passwordEnc;
    if (index >= 0) connections[index] = toSave;
    else connections.push(toSave);
    const activeId = cfg.activeId || toSave.id;
    saveDatabaseConfig({ connections, activeId });
    if (activeId === toSave.id) this.reset();
    return this.listConfig();
  }

  deleteConnection(id: string): DatabaseConfig {
    const cfg = loadDatabaseConfig();
    const connections = cfg.connections.filter((c) => c.id !== id);
    const activeId =
      cfg.activeId === id ? connections[0]?.id ?? '' : cfg.activeId;
    saveDatabaseConfig({ connections, activeId });
    this.reset();
    return this.listConfig();
  }

  setActive(id: string): DatabaseConfig {
    const cfg = loadDatabaseConfig();
    saveDatabaseConfig({ ...cfg, activeId: id });
    this.reset();
    return this.listConfig();
  }

  /** AI 工具使用的 runner */
  getRunner(): DatabaseRunner {
    return {
      isConfigured: () => Boolean(this.activeConnection()),
      query: (sql) => this.queryReadOnly(sql),
      execute: (sql, params) =>
        this.ensureDriver().then((d) => d.execute(sql, params)),
      schema: () => this.ensureDriver().then((d) => d.schema()),
    };
  }

  async testConnection(
    conn: DatabaseConnectionInput,
  ): Promise<{ ok: boolean; message: string }> {
    let driver: Driver | null = null;
    try {
      const toTest: DatabaseConnection = { ...conn };
      if (conn.password) toTest.passwordEnc = encryptSecret(conn.password);
      delete (toTest as { password?: string }).password;
      if (!toTest.passwordEnc) {
        const existing = loadDatabaseConfig().connections.find(
          (c) => c.id === conn.id,
        );
        toTest.passwordEnc = existing?.passwordEnc;
      }
      driver = await createDriver(toTest);
      await driver.query('SELECT 1');
      return { ok: true, message: '连接成功' };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    } finally {
      driver?.close();
    }
  }

  async schema(): Promise<DatabaseSchema> {
    const driver = await this.ensureDriver();
    return driver.schema();
  }

  async query(sql: string): Promise<unknown[]> {
    const driver = await this.ensureDriver();
    // 给 SELECT/WITH 追加 LIMIT，避免面板手动 SQL 拉全表
    const rows = await driver.query(appendLimit(sql, MAX_ROWS));
    return rows.slice(0, MAX_ROWS);
  }

  /** 只读查询：强制 LIMIT + 驱动层只读，用于 AI 的 query_database */
  async queryReadOnly(sql: string): Promise<unknown[]> {
    const driver = await this.ensureDriver();
    const rows = await driver.queryReadOnly(appendLimit(sql, MAX_ROWS));
    return rows.slice(0, MAX_ROWS);
  }

  /** 按表名取数（服务端按驱动方言引用标识符，避免注入） */
  async tableRows(name: string, limit = 200): Promise<unknown[]> {
    const driver = await this.ensureDriver();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, MAX_ROWS));
    const rows = await driver.query(
      `SELECT * FROM ${driver.quoteIdent(name)} LIMIT ${safeLimit}`,
    );
    return rows.slice(0, safeLimit);
  }

  async execute(sql: string): Promise<{ rowsAffected?: number }> {
    const driver = await this.ensureDriver();
    return driver.execute(sql);
  }

  /** 清空并重建演示数据（仅默认演示连接 + 默认路径 + SQLite） */
  async resetDemo(): Promise<void> {
    const conn = this.activeConnection();
    if (!conn) throw new Error('未配置数据库连接');
    if (
      conn.id !== DEMO_DB_ID ||
      conn.driver !== 'sqlite' ||
      conn.filename !== demoPath()
    ) {
      throw new Error('只能重置默认演示连接（演示数据库 SQLite）');
    }
    const driver = await this.ensureDriver();
    const schema = await driver.schema();
    for (const t of schema.tables) {
      await driver.execute(`DROP TABLE IF EXISTS ${driver.quoteIdent(t.name)}`);
    }
    await seedDemoDatabase(driver);
    this.reset();
  }

  private async ensureDriver(): Promise<Driver> {
    const conn = this.activeConnection();
    if (!conn) throw new Error('未配置数据库连接');
    if (this.driver && this.driverConnId === conn.id) return this.driver;
    if (this.connecting && this.connectingConnId === conn.id) {
      return this.connecting;
    }

    this.closeDriver();
    const promise = (async () => {
      const driver = await createDriver(conn);
      // 默认演示连接且为 SQLite：空库自动播种，开箱即用
      if (conn.id === DEMO_DB_ID && conn.driver === 'sqlite') {
        await seedDemoDatabase(driver);
      }
      // 只在仍是当前活动连接时缓存，避免切换后用错驱动
      if (this.activeConnection()?.id !== conn.id) {
        driver.close();
        throw new Error('数据库连接已切换，请重试');
      }
      this.driver = driver;
      this.driverConnId = conn.id;
      return driver;
    })();

    this.connecting = promise;
    this.connectingConnId = conn.id;
    try {
      return await promise;
    } finally {
      if (this.connectingConnId === conn.id) this.connecting = null;
    }
  }

  reset(): void {
    this.closeDriver();
    this.driverConnId = null;
    this.connecting = null;
    this.connectingConnId = null;
  }

  private closeDriver(): void {
    try {
      this.driver?.close();
    } catch {
      /* 忽略 */
    }
    this.driver = null;
  }
}

let manager: DatabaseManager | null = null;

export function getDatabaseManager(): DatabaseManager {
  if (!manager) manager = new DatabaseManager();
  return manager;
}
