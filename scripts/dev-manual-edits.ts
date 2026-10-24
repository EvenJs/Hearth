// pnpm dev:manual-edits --email you@example.com [--account "CBA Female"]
// 只给 dev 走查用（M3-9 的 U3）：模拟 fixtures/README "然后手动操作" 的两步
//   1. CBA #3（2026-09-25 +3,000.00）→ Income / Contract income (B2B)，is_pre_tax 跟分类默认值（true）
//   2. CBA #15（2026-09-08 +22.50）→ Entertainment & eat-out / Restaurants
// 改主拆分，category_source = manual。不按 R5.1 重算归属人（走查完会撤销，这两笔会被删掉）
// F8 改分类页面（M4）做完后这个脚本就没用了，可以删
//
// 安全：白名单。DEV_DATABASE_HOST 没设，或者 DATABASE_URL 不是这个主机，直接退出。
// 每笔要求正好找到 1 笔，否则什么都不改。报错只打印主机名，不打印连接串
import { parseArgs } from 'node:util';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, pool } from '../src/db/index.ts';
import {
  category,
  financialAccount,
  householdUser,
  transaction,
  transactionSplit,
  user,
} from '../src/db/schema.ts';

// Neon 的 pooled 主机名带 -pooler，比较前去掉（和 tests/helpers/test-db-guard.ts 一样）
function hostKey(urlOrHost: string): string {
  const host = urlOrHost.includes('://') ? new URL(urlOrHost).hostname : urlOrHost;
  return host
    .trim()
    .toLowerCase()
    .replace(/^([^.]+)-pooler\./, '$1.');
}

function guardDevOnly(): void {
  const devHost = process.env.DEV_DATABASE_HOST?.trim();
  if (!devHost) {
    throw new Error(
      '拒绝运行：.env.local 里没设 DEV_DATABASE_HOST（dev 的主机名，不带密码），没法确认现在连的是 dev',
    );
  }
  const current = hostKey(process.env.DATABASE_URL ?? '');
  if (current !== hostKey(devHost)) {
    throw new Error(
      `拒绝运行：DATABASE_URL 连的是 ${current}，不是 DEV_DATABASE_HOST。这个脚本只能连 dev`,
    );
  }
  console.log(`连接：${current}（dev）`);
}

const EDITS = [
  {
    label: 'CBA #3',
    date: '2026-09-25',
    amountCents: 300000,
    parent: 'Income',
    name: 'Contract income (B2B)',
  },
  {
    label: 'CBA #15',
    date: '2026-09-08',
    amountCents: 2250,
    parent: 'Entertainment & eat-out',
    name: 'Restaurants',
  },
] as const;

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    account: { type: 'string' },
  },
});

const input = z
  .object({
    email: z.email('email 格式不对').transform((v) => v.toLowerCase()),
    account: z.string().trim().min(1).default('CBA Female'),
  })
  .safeParse(values);

if (!input.success) {
  console.error('参数错误:', z.prettifyError(input.error));
  console.error('用法: pnpm dev:manual-edits --email a@b.com [--account "CBA Female"]');
  process.exit(1);
}

try {
  guardDevOnly();
  const { email, account: accountName } = input.data;

  const [hu] = await db
    .select({ householdId: householdUser.householdId })
    .from(householdUser)
    .innerJoin(user, eq(user.id, householdUser.userId))
    .where(eq(user.email, email));
  if (!hu) throw new Error(`找不到用户或用户没加进家庭: ${email}`);
  const hh = hu.householdId;

  const [acct] = await db
    .select({ id: financialAccount.id })
    .from(financialAccount)
    .where(and(eq(financialAccount.householdId, hh), eq(financialAccount.name, accountName)));
  if (!acct) throw new Error(`找不到账户: ${accountName}`);

  // 先全部查好，确认每笔都正好 1 笔，再一起改
  const planned: { label: string; splitId: string; categoryId: string; isPreTax: boolean }[] = [];
  for (const e of EDITS) {
    const [parent] = await db
      .select({ id: category.id })
      .from(category)
      .where(
        and(eq(category.householdId, hh), isNull(category.parentId), eq(category.nameEn, e.parent)),
      );
    if (!parent) throw new Error(`找不到一级分类: ${e.parent}`);
    const [cat] = await db
      .select({ id: category.id, isPreTaxDefault: category.isPreTaxDefault })
      .from(category)
      .where(
        and(
          eq(category.householdId, hh),
          eq(category.parentId, parent.id),
          eq(category.nameEn, e.name),
        ),
      );
    if (!cat) throw new Error(`找不到分类: ${e.parent} / ${e.name}`);

    const splits = await db
      .select({ id: transactionSplit.id })
      .from(transactionSplit)
      .innerJoin(transaction, eq(transaction.id, transactionSplit.transactionId))
      .where(
        and(
          eq(transaction.householdId, hh),
          eq(transaction.accountId, acct.id),
          eq(transaction.source, 'csv'),
          eq(transaction.date, e.date),
          eq(transaction.amountCents, e.amountCents),
          eq(transactionSplit.isPrimary, true),
        ),
      );
    if (splits.length !== 1) {
      throw new Error(
        `${e.label}（${e.date} ${e.amountCents}）应该正好 1 笔，找到 ${splits.length} 笔。先导入 cba/female-2026-09.csv`,
      );
    }
    planned.push({
      label: e.label,
      splitId: splits[0].id,
      categoryId: cat.id,
      isPreTax: cat.isPreTaxDefault,
    });
  }

  await db.transaction(async (tx) => {
    for (const p of planned) {
      await tx
        .update(transactionSplit)
        .set({ categoryId: p.categoryId, categorySource: 'manual', isPreTax: p.isPreTax })
        .where(and(eq(transactionSplit.id, p.splitId), eq(transactionSplit.householdId, hh)));
    }
  });
  for (const p of planned) console.log(`✓ ${p.label} 改成手动分类`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
