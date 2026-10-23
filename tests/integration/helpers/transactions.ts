// M3 集成测试 helper：手动录入 pending（M6 才有正式的录入函数）、读交易和主拆分、扫描完整号码
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { MemberSource } from '@/lib/rules/types';
import type { DbTestHousehold } from './db';

export type PendingInput = {
  account: string; // 账户名
  date: string;
  amountCents: number;
  category: string; // h.category 路径
  member: string; // 手动指定，member_source = manual
  note?: string;
  // 额外拆分（R15），金额从主拆分里扣
  extraSplits?: { amountCents: number; category: string }[];
};

// R8.1：anz、cba 账户手动录入 → pending，没有 dedupe_key。分类和归属人都是用户选的（manual）
export async function insertPending(t: DbTestHousehold, p: PendingInput): Promise<string> {
  const { ctx, h } = t;
  const extras = p.extraSplits ?? [];
  const primaryAmount = p.amountCents - extras.reduce((s, e) => s + e.amountCents, 0);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.transaction)
      .values({
        householdId: ctx.householdId,
        accountId: h.account(p.account).id,
        date: p.date,
        amountCents: p.amountCents,
        rawDescription: 'MANUAL ENTRY',
        merchant: 'MANUAL ENTRY',
        status: 'pending',
        source: 'manual',
        note: p.note ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: schema.transaction.id });
    const split = (amountCents: number, category: string, isPrimary: boolean) => ({
      householdId: ctx.householdId,
      transactionId: row.id,
      amountCents,
      categoryId: h.category(category).id,
      memberId: h.member(p.member).id,
      categorySource: 'manual',
      memberSource: 'manual',
      isPrimary,
      isPreTax: h.category(category).isPreTaxDefault,
    });
    await tx
      .insert(schema.transactionSplit)
      .values([
        split(primaryAmount, p.category, true),
        ...extras.map((e) => split(e.amountCents, e.category, false)),
      ]);
    return row.id;
  });
}

export type TxRow = Awaited<ReturnType<typeof listTransactions>>[number];

// 某个账户的交易 + 主拆分。按日期新的在前、同一天金额大的在前，正好是 fixtures 文件的顺序
export async function listTransactions(t: DbTestHousehold, account: string) {
  return db
    .select({
      id: schema.transaction.id,
      date: schema.transaction.date,
      amountCents: schema.transaction.amountCents,
      rawDescription: schema.transaction.rawDescription,
      merchant: schema.transaction.merchant,
      cardLast4: schema.transaction.cardLast4,
      balanceCents: schema.transaction.balanceCents,
      status: schema.transaction.status,
      source: schema.transaction.source,
      transferStatus: schema.transaction.transferStatus,
      transferPairId: schema.transaction.transferPairId,
      dedupeKey: schema.transaction.dedupeKey,
      importBatchId: schema.transaction.importBatchId,
      note: schema.transaction.note,
      confirmedAt: schema.transaction.confirmedAt,
      splitAmountCents: schema.transactionSplit.amountCents,
      categoryId: schema.transactionSplit.categoryId,
      categorySource: schema.transactionSplit.categorySource,
      memberId: schema.transactionSplit.memberId,
      memberSource: schema.transactionSplit.memberSource,
      isPreTax: schema.transactionSplit.isPreTax,
      splitCount: sql<number>`(select count(*)::int from ${schema.transactionSplit} s where s.transaction_id = ${schema.transaction.id})`,
    })
    .from(schema.transaction)
    .innerJoin(
      schema.transactionSplit,
      and(
        eq(schema.transactionSplit.transactionId, schema.transaction.id),
        eq(schema.transactionSplit.isPrimary, true),
      ),
    )
    .where(
      and(
        eq(schema.transaction.householdId, t.ctx.householdId),
        eq(schema.transaction.accountId, t.h.account(account).id),
      ),
    )
    .orderBy(
      desc(schema.transaction.date),
      desc(schema.transaction.amountCents),
      asc(schema.transaction.id),
    );
}

export async function getTransaction(id: string) {
  const [row] = await db.select().from(schema.transaction).where(eq(schema.transaction.id, id));
  return row;
}

export async function getSplits(transactionId: string) {
  return db
    .select()
    .from(schema.transactionSplit)
    .where(eq(schema.transactionSplit.transactionId, transactionId))
    .orderBy(desc(schema.transactionSplit.isPrimary), asc(schema.transactionSplit.amountCents));
}

export type MemberExpect = { member: string; source: MemberSource };

// 入库检查：把所有表的每一行转成 JSON 文本，找完整号码。auth 表也查
export async function findNumbersInDatabase(numbers: readonly string[]): Promise<string[]> {
  const result = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const found: string[] = [];
  for (const { table_name } of result.rows) {
    for (const n of numbers) {
      const hit = await db.execute<{ c: number }>(
        sql`select count(*)::int as c from ${sql.identifier(table_name)} t where row_to_json(t)::text like ${'%' + n + '%'}`,
      );
      if (hit.rows[0].c > 0) found.push(`${table_name}: ${n}`);
    }
  }
  return found;
}
