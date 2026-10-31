import dotenv from 'dotenv';
import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * 加载桌面端 .env：API Key 只放环境变量，不写进配置文件。
 * 查找顺序：DOTENV_CONFIG_PATH → 当前目录 .env → userData/.env
 */
export function loadEnv(): void {
  const candidates: string[] = [];
  if (process.env.DOTENV_CONFIG_PATH) {
    candidates.push(process.env.DOTENV_CONFIG_PATH);
  }
  candidates.push(join(process.cwd(), '.env'));
  try {
    candidates.push(join(app.getPath('userData'), '.env'));
  } catch {
    /* userData 不可用时忽略 */
  }

  for (const path of candidates) {
    if (existsSync(path)) {
      dotenv.config({ path });
      console.log(`🔑 已加载环境变量: ${path}`);
    }
  }
}
