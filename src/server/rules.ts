// F8 存成规则和重新应用（M4-4）：R13、R16.6 新建规则，R7.2 重新应用
// 设置 → 规则（M6.5-3）：R18 列表、新建、修改、删除
// 怎么重新分类由 src/lib/rules/split-edit.ts 的 planReapply 算，这里负责读、写、事务
import { and, asc, eq, exists, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { categoryRule, transaction, transactionSplit } from '@/db/schema';
import { normalizeKeyword } from '@/lib/rules/keyword';
import { checkRuleEdit, filterRules, ruleHits } from '@/lib/rules/rule-admin';
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

// ---------- 设置 → 规则（M6.5-3，R18） ----------
// 判断都在 src/lib/rules/rule-admin.ts（checkRuleEdit、ruleHits），这里负责读、写、事务
// 和 F8 的 createRule 不同：撞了关键词直接报错，不走 R16.6 的覆盖（R18.2）

export type RuleListItem = {
  id: string;
  keyword: string;
  matchType: RuleMatchType;
  categoryId: string;
  categoryLabel: string; // "Groceries / Supermarket"
  topCategoryId: string; // 一级 id，一级本身就是自己。R18.1 按一级筛选、分类 tag 颜色用
  hits: number; // R18.1
  isSystem: boolean; // R18.1 "预置"标签
};

export type RuleWriteInput = {
  keyword: string;
  matchType: RuleMatchType;
  categoryId: string;
};

export type RuleWriteResult =
  | { ok: true; ruleId: string }
  | { ok: false; reason: 'invalid'; message: string }
  // R18.2："已有规则 X → Y"。conflictRuleId：撞了的那条，并发时可能拿不到
  | { ok: false; reason: 'conflict'; message: string; conflictRuleId?: string }
  | { ok: false; reason: 'not_found'; message: string };

const NOT_FOUND = { ok: false, reason: 'not_found', message: '规则不存在' } as const;

// 结构校验。关键词的规范化和长度在 checkRuleEdit 里做（R18.2）
const ruleWriteSchema = z.object({
  keyword: z.string(),
  matchType: z.enum(RULE_MATCH_TYPES),
  categoryId: z.uuid(),
});

// R18.1 列表：所有规则，带分类显示名、一级 id、命中数，按关键词排序
// 搜索和一级筛选由页面用 filterRules 做
export async function listRules(ctx: HouseholdContext): Promise<RuleListItem[]> {
  return db.transaction(
    async (tx) => {
      const { categories } = await loadEditContext(tx, ctx);
      const rules = await loadRules(tx, ctx);
      // R18.1 只看 merchant 和转账状态，不管现在的分类和来源，所以读全部交易
      const txs = await tx
        .select({ merchant: transaction.merchant, transferStatus: transaction.transferStatus })
        .from(transaction)
        .where(eq(transaction.householdId, ctx.householdId));
      const hits = ruleHits(txs, rules);

      return filterRules(rules, {}, categories).map((r) => {
        const c = categories.find((x) => x.id === r.categoryId)!;
        const parent = c.parentId ? categories.find((x) => x.id === c.parentId) : undefined;
        return {
          id: r.id,
          keyword: r.keyword,
          matchType: r.matchType,
          categoryId: r.categoryId,
          categoryLabel: categoryLabel(c, parent?.nameEn),
          topCategoryId: c.parentId ?? c.id,
          hits: hits.get(r.id) ?? 0,
          isSystem: r.isSystem,
        };
      });
    },
    { accessMode: 'read only' },
  );
}

// 唯一约束 (household_id, keyword, match_type)：两次保存同时撞上时的兜底。drizzle 把驱动错误包在 cause 里
function isRuleUniqueViolation(err: unknown): boolean {
  const pgError = (err as { cause?: unknown })?.cause ?? err;
  const { code, constraint } = (pgError ?? {}) as { code?: string; constraint?: string };
  return code === '23505' && constraint === 'category_rule_household_id_keyword_match_type_unique';
}

async function withConflictFallback(
  keyword: string,
  write: () => Promise<RuleWriteResult>,
): Promise<RuleWriteResult> {
  try {
    return await write();
  } catch (err) {
    if (!isRuleUniqueViolation(err)) throw err;
    return { ok: false, reason: 'conflict', message: `已有规则 ${normalizeKeyword(keyword)}` };
  }
}

// 跑 checkRuleEdit，把结果换成 RuleWriteResult 的报错
type Checked = { ok: true; value: RuleWriteInput } | Extract<RuleWriteResult, { ok: false }>;

async function check(
  tx: DbTx,
  ctx: HouseholdContext,
  input: RuleWriteInput,
  selfId?: string,
): Promise<Checked> {
  const { categories } = await loadEditContext(tx, ctx);
  const rules = await loadRules(tx, ctx);
  const r = checkRuleEdit(input, rules, categories, selfId);
  if (r.ok) return r;
  return r.conflictRuleId
    ? { ok: false, reason: 'conflict', message: r.message, conflictRuleId: r.conflictRuleId }
    : { ok: false, reason: 'invalid', message: r.message };
}

// R18.2 新建：priority = 0、is_system = false（列默认值）。撞了报错，什么都不写
export async function createRuleFromSettings(
  ctx: HouseholdContext,
  input: RuleWriteInput,
): Promise<RuleWriteResult> {
  const parsed = ruleWriteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid', message: '输入不对' };

  return withConflictFallback(parsed.data.keyword, () =>
    db.transaction(async (tx): Promise<RuleWriteResult> => {
      const c = await check(tx, ctx, parsed.data);
      if (!c.ok) return c;
      const [row] = await tx
        .insert(categoryRule)
        .values({ householdId: ctx.householdId, ...c.value })
        .returning({ id: categoryRule.id });
      return { ok: true, ruleId: row.id };
    }),
  );
}

// R18.2 修改：只改关键词、匹配方式、分类。priority、is_system、created_at 不动
// （created_at 是 R7 第 3 步的最后一个排序条件；改过的预置规则还显示"预置"）
export async function updateRule(
  ctx: HouseholdContext,
  ruleId: string,
  input: RuleWriteInput,
): Promise<RuleWriteResult> {
  if (!z.uuid().safeParse(ruleId).success) return NOT_FOUND;
  const parsed = ruleWriteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid', message: '输入不对' };

  return withConflictFallback(parsed.data.keyword, () =>
    db.transaction(async (tx): Promise<RuleWriteResult> => {
      const [own] = await tx
        .select({ id: categoryRule.id })
        .from(categoryRule)
        .where(and(eq(categoryRule.id, ruleId), eq(categoryRule.householdId, ctx.householdId)))
        .for('update');
      if (!own) return NOT_FOUND;

      const c = await check(tx, ctx, parsed.data, ruleId);
      if (!c.ok) return c;
      await tx
        .update(categoryRule)
        .set(c.value)
        .where(and(eq(categoryRule.id, ruleId), eq(categoryRule.householdId, ctx.householdId)));
      return { ok: true, ruleId };
    }),
  );
}

// R18.3 删除：只删规则，不动已经分好类的交易（category_source 还是 rule）
export async function deleteRule(ctx: HouseholdContext, ruleId: string): Promise<RuleWriteResult> {
  if (!z.uuid().safeParse(ruleId).success) return NOT_FOUND;
  const deleted = await db
    .delete(categoryRule)
    .where(and(eq(categoryRule.id, ruleId), eq(categoryRule.householdId, ctx.householdId)))
    .returning({ id: categoryRule.id });
  return deleted.length > 0 ? { ok: true, ruleId } : NOT_FOUND;
}
