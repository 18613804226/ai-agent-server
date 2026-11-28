/** MCP Server 配置：stdio（本地进程）或 http（Streamable HTTP） */
export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  id: string;
  /** 显示名，同时用于工具名前缀的可读部分 */
  name: string;
  enabled: boolean;
  transport: McpTransport;
  /** stdio：可执行命令，如 npx */
  command?: string;
  /** stdio：命令参数，如 ["-y","@modelcontextprotocol/server-filesystem","."] */
  args?: string[];
  /** stdio：附加环境变量 */
  env?: Record<string, string>;
  /** stdio：工作目录 */
  cwd?: string;
  /** http：MCP 服务地址，如 http://127.0.0.1:3001/mcp */
  url?: string;
}

export interface McpServerStatus {
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}
