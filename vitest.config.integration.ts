import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * 集成测试配置：需要真实 PostgreSQL / 真实外部 API 的用例。
 * 用 `npm run test:integration` 单独跑，不混进默认的单元测试。
 * 约定：文件放在 test/integration/ 下，命名 *.integration.spec.ts
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.integration.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // 集成用例要等 DB / 外部 API，单个用例放宽超时
    testTimeout: 30000,
  },
});
