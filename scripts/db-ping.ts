// pnpm db:ping：执行 select 1，确认能连上 DATABASE_URL 指向的数据库
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/index.ts';

try {
  const result = await db.execute<{ ok: number; database: string }>(
    sql`select 1 as ok, current_database() as database`,
  );
  console.log('数据库连接成功:', result.rows[0]);
} catch (error) {
  console.error('数据库连接失败:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
