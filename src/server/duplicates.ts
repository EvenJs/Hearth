// R17.6 可能重复的 pending：F8 列表和交易详情实时判断，不另存状态
// 导入批次 warnings.possibleDuplicates 记了 { transactionId, pendingIds }（R8.2 候选 ≥ 2），
// 这里查那些 pending 现在还在不在、还是不是 pending，交给 activeDuplicates 算
// 单独一个文件，transactions.ts 和 manual.ts 都能用，不互相 import
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { importBatch, transaction } from '@/db/schema';
import { activeDuplicates, type PossibleDuplicate } from '@/lib/rules/manual';
import type { TransactionStatus } from '@/lib/rules/pending';
import type { HouseholdContext } from './context';

// 交易 id → 同组里其他还在显示的交易 id
export type DuplicateGroups = Map<string, string[]>;

export type PossibleDuplicates = {
  groups: DuplicateGroups; // 所有带"可能重复"标签的交易（pending 和银行那笔）
  pendingIds: Set<string>; // 其中还是 pending 的手动录入：F8 提示条的 N（M6-6）
};

export async function getPossibleDuplicates(ctx: HouseholdContext): Promise<PossibleDuplicates> {
  const hh = ctx.householdId;
  // 撤销导入（R12.1）后批次没了，提示跟着消失
  const batches = await db
    .select({ warnings: importBatch.warnings })
    .from(importBatch)
    .where(
      and(
        eq(importBatch.householdId, hh),
        // AND 不保证短路，用 CASE 防止对不是数组的值调 jsonb_array_length
        sql`case when jsonb_typeof(${importBatch.warnings}->'possibleDuplicates') = 'array'
          then jsonb_array_length(${importBatch.warnings}->'possibleDuplicates') else 0 end > 0`,
      ),
    );
  const records = batches.flatMap(
    (b) => (b.warnings as { possibleDuplicates: PossibleDuplicate[] }).possibleDuplicates,
  );
  const groups: DuplicateGroups = new Map();
  const pending = new Set<string>();
  if (records.length === 0) return { groups, pendingIds: pending };

  // 被删掉的 pending 查不到，正好不进 states
  const pendingIds = [...new Set(records.flatMap((r) => r.pendingIds))];
  const rows = await db
    .select({ id: transaction.id, status: transaction.status })
    .from(transaction)
    .where(and(eq(transaction.householdId, hh), inArray(transaction.id, pendingIds)));
  const states = new Map<string, TransactionStatus>(rows.map((r) => [r.id, r.status]));

  // 每条记录单独算一组，组里每笔的"对方"是同组其他几笔
  for (const record of records) {
    const group = activeDuplicates([record], states);
    for (const id of group) {
      const others = new Set(groups.get(id) ?? []);
      for (const other of group) if (other !== id) others.add(other);
      groups.set(id, [...others]);
      if (states.get(id) === 'pending') pending.add(id);
    }
  }
  return { groups, pendingIds: pending };
}
