import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit 不会自动读 .env.local，本地手动加载；Vercel 上用项目设置里的环境变量
if (existsSync('.env.local')) {
  process.loadEnvFile('.env.local');
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL 没有设置，检查 .env.local');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
});
