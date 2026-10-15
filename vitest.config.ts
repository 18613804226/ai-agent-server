import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // 默认只跑单元测试：纯函数 + mock，快且不依赖外部服务，保证始终是绿的
    include: ['**/*.spec.ts'],
    // 集成测试要真实 DB / 外部 API，单独用 `npm run test:integration` 跑
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.spec.ts'],
  },
});
