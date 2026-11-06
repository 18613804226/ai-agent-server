/**
 * 数据库连接配置的共享类型与常量。
 * 主进程与渲染进程都从这里引用，避免结构类型重复导致静默漂移。
 */

/** 数据库连接配置（密码只存加密后的 passwordEnc） */
export interface DatabaseConnection {
  id: string;
  name: string;
  driver: 'postgres' | 'mysql' | 'sqlite';
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  passwordEnc?: string;
  ssl?: boolean;
  /** SQLite 文件路径 */
  filename?: string;
}

export interface DatabaseConfig {
  connections: DatabaseConnection[];
  activeId: string;
}

/** 保存连接时的入参：可带明文密码，落盘前加密 */
export type DatabaseConnectionInput = Omit<
  DatabaseConnection,
  'passwordEnc'
> & { password?: string };

/** 默认演示连接 id */
export const DEMO_DB_ID = 'demo-sqlite';
