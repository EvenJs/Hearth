import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 和 tsconfig.json 的 paths 保持一致：@/* -> src/*
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    projects: [
      {
        // pnpm test：纯函数和 helper，不连数据库
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: ['tests/integration/**', '**/node_modules/**'],
        },
      },
      {
        // pnpm test:db：连 TEST_DATABASE_URL（M3-2）。没设时整组跳过
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/setup/global-setup.ts'],
          setupFiles: ['tests/integration/setup/per-file.ts'],
          // 共用一个库、每个测试前清表，文件之间不能并行
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
