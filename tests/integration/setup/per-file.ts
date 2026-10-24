// 每个测试文件 import 之前跑：换好 DATABASE_URL，文件结束时关掉连接池
import { afterAll } from 'vitest';
import { prepareTestDbEnv } from './test-db-env';

const { enabled } = prepareTestDbEnv();

if (enabled) {
  afterAll(async () => {
    const { pool } = await import('@/db');
    await pool.end();
  });
}
