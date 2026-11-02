// 整组开跑前检查一次：连接串指向 dev 时打印原因并直接退出（exit 1），一个测试都不跑
// 自己打印再 exit：vitest 打印 globalSetup 抛出的错误时会崩，看不到原因
// 检查通过后把 drizzle/ 里的迁移跑到 test 库，dev 跑了新迁移不用再手动迁 test
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import ws from 'ws';
import { prepareTestDbEnv } from './test-db-env';

export default async function setup() {
  let enabled: boolean;
  try {
    ({ enabled } = prepareTestDbEnv());
  } catch (error) {
    console.error(`\n[test:db] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (!enabled) {
    console.warn('[test:db] 没设 TEST_DATABASE_URL，tests/integration 整组跳过');
    return;
  }

  // prepareTestDbEnv 已经把 DATABASE_URL 换成 TEST_DATABASE_URL
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: './drizzle' });
  } catch (error) {
    console.error(
      `\n[test:db] test 库迁移失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  } finally {
    await pool.end();
  }
}
