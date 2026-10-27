// 整个家庭的 R6.2 配对、R6.3 兜底建议（business-rules.md R6.2、R6.3）
// 导入（R12 第 6 步）和保存账户后重新识别（R6.4 第 4 步）共用。必须在调用方的事务里跑
import { and, eq, isNull, sql } from 'drizzle-orm';
import { transaction, transactionSplit } from '@/db/schema';
import type { MemberContext } from '@/lib/rules/member';
import {
  planTransfers,
  storedTransferAccountId,
  type HouseholdTransferTx,
  type TransferPlan,
} from '@/lib/rules/transfer';
import type { CategorySource, MemberSource } from '@/lib/rules/types';
import type { HouseholdContext } from './context';
import type { DbTx } from './transactions';

export const splitCountSql = sql<number>`(select count(*)::int from ${transactionSplit} s where s.transaction_id = ${transaction.id})`;

export const primarySplitJoin = and(
  eq(transactionSplit.transactionId, transaction.id),
  eq(transactionSplit.isPrimary, true),
);

export type PairOptions = {
  // R6.3 只从这些交易出发。传空集合 → 只做 R6.2，不产生新的建议
  newIds: ReadonlySet<string>;
  // 本次导入的交易用内存里 R6.1 的结果（完整账号还在）；不在这里的 auto 转账从脱敏后的描述重认
  knownTransferAccount?: ReadonlyMap<string, string | null>;
};

// R6.2 整个家庭配对，然后 R6.3 建议，结果写回数据库。返回算出的计划（导入结果页要用）
export async function pairHouseholdTransfers(
  tx: DbTx,
  ctx: HouseholdContext,
  memberCtx: MemberContext,
  { newIds, knownTransferAccount = new Map() }: PairOptions,
): Promise<TransferPlan> {
  const hh = ctx.householdId;
  const accountById = new Map(memberCtx.accounts.map((a) => [a.id, a]));

  // 整个家庭还没配对的 confirmed 交易（pending 不参与，等它被导入确认时再检查）
  const unpaired = await tx
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      date: transaction.date,
      amountCents: transaction.amountCents,
      rawDescription: transaction.rawDescription,
      cardLast4: transaction.cardLast4,
      transferStatus: transaction.transferStatus,
      categoryId: transactionSplit.categoryId,
      categorySource: transactionSplit.categorySource,
      memberId: transactionSplit.memberId,
      memberSource: transactionSplit.memberSource,
      splitCount: splitCountSql,
    })
    .from(transaction)
    .innerJoin(transactionSplit, primarySplitJoin)
    .where(
      and(
        eq(transaction.householdId, hh),
        eq(transaction.status, 'confirmed'),
        isNull(transaction.transferPairId),
      ),
    );

  const householdTxs: HouseholdTransferTx[] = unpaired.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    date: t.date,
    amountCents: t.amountCents,
    transferStatus: t.transferStatus,
    transferAccountId: knownTransferAccount.has(t.id)
      ? knownTransferAccount.get(t.id)!
      : t.transferStatus === 'auto'
        ? storedTransferAccountId(
            t.rawDescription,
            accountById.get(t.accountId)!,
            memberCtx.accounts,
          )
        : null,
    transferPairId: null,
    categoryId: t.categoryId,
    categorySource: t.categorySource as CategorySource,
    splitCount: t.splitCount,
    cardLast4: t.cardLast4,
    memberId: t.memberId,
    memberSource: t.memberSource as MemberSource,
  }));

  const transfers = planTransfers(householdTxs, newIds, memberCtx);

  const byId = (id: string) => and(eq(transaction.id, id), eq(transaction.householdId, hh));
  for (const p of transfers.pairs) {
    await tx.update(transaction).set({ transferPairId: p.bId }).where(byId(p.aId));
    const u = p.counterpartUpdate;
    await tx
      .update(transaction)
      .set({ transferPairId: p.aId, ...(u ? { transferStatus: u.transferStatus } : {}) })
      .where(byId(p.bId));
    if (u) {
      await tx
        .update(transactionSplit)
        .set({
          categoryId: u.categoryId,
          categorySource: u.categorySource,
          isPreTax: u.isPreTax,
          memberId: u.memberId,
          memberSource: u.memberSource,
        })
        .where(
          and(
            eq(transactionSplit.transactionId, p.bId),
            eq(transactionSplit.householdId, hh),
            eq(transactionSplit.isPrimary, true),
          ),
        );
    }
  }
  // R6.3：两边都标 suggested 并配对，分类和归属人不动（确认前还是未分类）
  for (const s of transfers.suggestions) {
    await tx
      .update(transaction)
      .set({ transferStatus: 'suggested', transferPairId: s.bId })
      .where(byId(s.aId));
    await tx
      .update(transaction)
      .set({ transferStatus: 'suggested', transferPairId: s.aId })
      .where(byId(s.bId));
  }
  return transfers;
}
