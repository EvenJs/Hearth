// F8 存成规则和重新应用（M4-4）：R13、R16.6 新建规则，R7.2 重新应用
// 怎么重新分类由 src/lib/rules/split-edit.ts 的 planReapply 算，这里负责读、写、事务
import { and, asc, eq, exists, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { categoryRule, transaction, transactionSplit } from '@/db/schema';
import { normalizeKeyword } from '@/lib/rules/keyword';
import { planReapply, isSelectableCategory, type ReapplyTx } from '@/lib/rules/split-edit';
import {
  RULE_MATCH_TYPES,
  type CategoryRule,
  type CategorySource,
  type MemberSource,
  type RuleMatchType,
} from '@/lib/rules/types';
import type { HouseholdContext } from './context';
import { loadEditContext, writeSplit, type DbTx } from './transactions';

// ---------- 新建规则（R13、R16.6） ----------

export type CreateRuleInput = {
  keyword: string;
  matchType: RuleMatchType;
  categoryId: string;
  // R16.6：已有同样的规则、指向不同分类时，用户在对话框里确认了才改
  overwrite?: boolean;
};

export type ExistingRule = {
  id: string;
  keyword: string;
  matchType: RuleMatchType;
  categoryId: string;
  categoryLabel: string; // "Groceries / Supermarket"
};

// created：新建；unchanged：已有同样的规则、分类相同；updated：已有规则改成了新分类
// 三种情况之后都可以问"是否应用"（R7.2）
export type CreateRuleResult =
  | { ok: true; status: 'created' | 'unchanged' | 'updated'; ruleId: string }
  | { ok: false; reason: 'invalid'; message: string }
  // R16.6：没带 overwrite，什么都没改，UI 用 message 弹对话框
  | { ok: false; reason: 'conflict'; message: string; existing: ExistingRule };

// normalizeKeyword 挪到了 src/lib/rules/keyword.ts（M6.5-2），这里继续导出，调用方不用改
export { normalizeKeyword };

const createRuleSchema = z.object({
  keyword: z.string().transform(normalizeKeyword).pipe(z.string().min(1).max(100)),
  matchType: z.enum(RULE_MATCH_TYPES),
  categoryId: z.uuid(),
  overwrite: z.boolean().optional(),
});

// 分类显示名：二级带上一级
function categoryLabel(c: { nameEn: string; parentId: string | null }, parentName?: string) {
  return c.parentId && parentName ? `${parentName} / ${c.nameEn}` : c.nameEn;
}

// R13 存成规则。分类要属于本家庭、能选（R16.3：内部转账和归档的不能选）
// 已有同样的 (keyword, match_type)：分类相同什么都不做；不同时没带 overwrite 返回 conflict，
// 带了就把那条规则改成新分类，预置规则也可以改（R16.6）
export async function createRule(
  ctx: HouseholdContext,
  input: CreateRuleInput,
): Promise<CreateRuleResult> {
  const parsed = createRuleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid', message: '关键词不能为空' };
  const { keyword, matchType, categoryId, overwrite } = parsed.data;

  return db.transaction(async (tx) => {
    const editCtx = await loadEditContext(tx, ctx);
    const target = editCtx.categories.find((c) => c.id === categoryId);
    if (!target || !isSelectableCategory(target)) {
      return { ok: false, reason: 'invalid', message: '不能选这个分类' };
    }

    const [existing] = await tx
      .select({
        id: categoryRule.id,
        categoryId: categoryRule.categoryId,
      })
      .from(categoryRule)
      .where(
        and(
          eq(categoryRule.householdId, ctx.householdId),
          eq(categoryRule.keyword, keyword),
          eq(categoryRule.matchType, matchType),
        ),
      )
      .for('update');

    if (!existing) {
      const [row] = await tx
        .insert(categoryRule)
        .values({ householdId: ctx.householdId, keyword, matchType, categoryId })
        .returning({ id: categoryRule.id });
      return { ok: true, status: 'created', ruleId: row.id };
    }

    if (existing.categoryId === categoryId) {
      return { ok: true, status: 'unchanged', ruleId: existing.id };
    }

    if (!overwrite) {
      const old = editCtx.categories.find((c) => c.id === existing.categoryId)!;
      const parent = editCtx.categories.find((c) => c.id === old.parentId);
      const label = categoryLabel(old, parent?.nameEn);
      return {
        ok: false,
        reason: 'conflict',
        message: `已有规则 ${keyword} → ${label}`,
        existing: { id: existing.id, keyword, matchType, categoryId: old.id, categoryLabel: label },
      };
    }

    await tx
      .update(categoryRule)
      .set({ categoryId })
      .where(and(eq(categoryRule.id, existing.id), eq(categoryRule.householdId, ctx.householdId)));
    return { ok: true, status: 'updated', ruleId: existing.id };
  });
}

// ---------- 重新应用（R7.2） ----------

// changeCount：会改的交易笔数；skippedCount：本来会被考虑、但有多个拆分跳过的笔数
export type ReapplyPreview = { changeCount: number; skippedCount: number };
export type ReapplyResult = { updatedCount: number; skippedCount: number };

async function loadRules(tx: DbTx, ctx: HouseholdContext): Promise<CategoryRule[]> {
  return tx
    .select({
      id: categoryRule.id,
      keyword: categoryRule.keyword,
      matchType: categoryRule.matchType,
      categoryId: categoryRule.categoryId,
      priority: categoryRule.priority,
      isSystem: categoryRule.isSystem,
      createdAt: categoryRule.createdAt,
    })
    .from(categoryRule)
    .where(eq(categoryRule.householdId, ctx.householdId));
}

// R7.2 只看有"可重新应用"拆分的交易：category_source = rule，或者 system 且是未分类
// 这样 skippedCount 只算真的会被考虑的多拆分交易，不把全是 manual 的多拆分交易也算进去
function hasReapplicableSplit(ctx: HouseholdContext, uncategorizedId: string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(transactionSplit)
      .where(
        and(
          eq(transactionSplit.transactionId, transaction.id),
          eq(transactionSplit.householdId, ctx.householdId),
          or(
            eq(transactionSplit.categorySource, 'rule'),
            and(
              eq(transactionSplit.categorySource, 'system'),
              eq(transactionSplit.categoryId, uncategorizedId),
            ),
          ),
        ),
      ),
  );
}

// 读出要算的交易和它们所有的拆分。lock = true 时锁住这些拆分，直到事务结束
async function loadReapplyTxs(
  tx: DbTx,
  ctx: HouseholdContext,
  uncategorizedId: string,
  lock: boolean,
): Promise<ReapplyTx[]> {
  const txRows = await tx
    .select({
      id: transaction.id,
      merchant: transaction.merchant,
      accountId: transaction.accountId,
      cardLast4: transaction.cardLast4,
      transferStatus: transaction.transferStatus,
    })
    .from(transaction)
    .where(
      and(eq(transaction.householdId, ctx.householdId), hasReapplicableSplit(ctx, uncategorizedId)),
    )
    .orderBy(asc(transaction.id));
  if (txRows.length === 0) return [];

  const splitQuery = tx
    .select({
      id: transactionSplit.id,
      transactionId: transactionSplit.transactionId,
      categoryId: transactionSplit.categoryId,
      categorySource: transactionSplit.categorySource,
      memberId: transactionSplit.memberId,
      memberSource: transactionSplit.memberSource,
      isPreTax: transactionSplit.isPreTax,
    })
    .from(transactionSplit)
    .where(
      and(
        eq(transactionSplit.householdId, ctx.householdId),
        inArray(
          transactionSplit.transactionId,
          txRows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(transactionSplit.id));
  const splitRows = lock ? await splitQuery.for('update') : await splitQuery;

  const byTx = new Map<string, ReapplyTx['splits'][number][]>();
  for (const s of splitRows) {
    const list = byTx.get(s.transactionId) ?? [];
    list.push({
      id: s.id,
      categoryId: s.categoryId,
      categorySource: s.categorySource as CategorySource,
      memberId: s.memberId,
      memberSource: s.memberSource as MemberSource,
      isPreTax: s.isPreTax,
    });
    byTx.set(s.transactionId, list);
  }
  return txRows.map((r) => ({ ...r, splits: byTx.get(r.id) ?? [] }));
}

async function plan(tx: DbTx, ctx: HouseholdContext, lock: boolean) {
  const editCtx = await loadEditContext(tx, ctx);
  const uncategorized = editCtx.categories.find((c) => c.systemKey === 'uncategorized');
  if (!uncategorized) throw new Error('系统分类不存在: uncategorized');
  const rules = await loadRules(tx, ctx);
  const txs = await loadReapplyTxs(tx, ctx, uncategorized.id, lock);
  return planReapply(txs, rules, editCtx);
}

// R7.2 预览：会改几笔、跳过几笔。只读
export async function previewReapply(ctx: HouseholdContext): Promise<ReapplyPreview> {
  // 用只读事务，读到的分类、规则、交易是同一个时间点的
  return db.transaction(
    async (tx) => {
      const p = await plan(tx, ctx, false);
      return { changeCount: p.updates.length, skippedCount: p.skipped };
    },
    { accessMode: 'read only' },
  );
}

// R7.2 重新应用：一个事务，按 planReapply 改，分类变了的按 R5.1 重算归属人
export async function reapplyRules(ctx: HouseholdContext): Promise<ReapplyResult> {
  return db.transaction(async (tx) => {
    const p = await plan(tx, ctx, true);
    for (const u of p.updates) await writeSplit(tx, ctx, u.split);
    return { updatedCount: p.updates.length, skippedCount: p.skipped };
  });
}
