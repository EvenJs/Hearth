// pnpm db:seed --email you@example.com [--household "My Family"]
// 主体在 src/server/seed.ts：household、member、household_user 每次都补（幂等）；
// 分类和预置规则只在本家庭还没有分类时插（R18.5、R19.5），之后在设置页管理
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { pool } from '../src/db/index.ts';
import { seedHousehold } from '../src/server/seed.ts';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    household: { type: 'string' },
  },
});

const input = z
  .object({
    email: z.email('email 格式不对').transform((v) => v.toLowerCase()),
    household: z.string().trim().min(1).default('My Family'),
  })
  .safeParse(values);

if (!input.success) {
  console.error('参数错误:', z.prettifyError(input.error));
  console.error('用法: pnpm db:seed --email a@b.com [--household "My Family"]');
  process.exit(1);
}

const { email, household: householdName } = input.data;

try {
  const { counts, catalogSkipped } = await seedHousehold({ email, householdName });
  console.log(`seed 完成（${email}）`);
  if (catalogSkipped) {
    console.log('category / category_rule：已有分类，跳过（R19.5）');
  }
  console.table(counts);
} catch (error) {
  console.error('seed 失败，已回滚:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
