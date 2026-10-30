// 预算的数据层（M7-2，R11、R11.1、R11.2、R11.3）
// 总览和能不能设预算的判断在 src/lib/rules/budget.ts，这里负责读、写、事务
// 删除是硬删除（R11.3）；分类归档时一起删在 categories.ts 的 archiveCategory 里（R19.4）
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { budget, category, transaction, transactionSplit } from '@/db/schema';
import { budgetOverview, canHaveBudget, type BudgetOverview } from '@/lib/rules/budget';
import { parseAmountToCents } from '@/lib/rules/money';
import { endOfMonth, startOfMonth } from '@/lib/rules/periods';
import type { BudgetProgress, StatSplit } from '@/lib/rules/stats';
import type { Category } from '@/lib/rules/types';
import type { HouseholdContext } from './context';
import type { DbTx } from './transactions';

type BudgetCategory = Category & { sortOrder: number; isArchived: boolean };

export type BudgetItem = {
  id: string;
  categoryId: string;
  parentId: string | null; // 分类的一级；一级预算是 null
  label: string; // 一级 "Groceries"；二级 "Entertainment & eat-out / Bubble tea"
  monthlyLimitCents: number;
  warnAtPercent: number;
  isPinned: boolean;
  progress: BudgetProgress; // R11 自己的进度和颜色
  includedIn: string | null; // 一级也有预算时 = 一级 id：已含在一级里，不进合计（R11.1）
};

export type BudgetsWithProgress = {
  // 一级按 sort_order，二级预算跟在它的一级后面，现金支出排最后
  budgets: BudgetItem[];
  overview: BudgetOverview; // R11.1，本月、全家
};

export type BudgetWriteResult =
  | { ok: true; budgetId: string }
  | { ok: false; reason: 'invalid' | 'not_found'; message: string };

const BUDGET_NOT_FOUND = { ok: false, reason: 'not_found', message: '预算不存在' } as const;
const CATEGORY_NOT_FOUND = { ok: false, reason: 'not_found', message: '分类不存在' } as const;
const INVALID = { ok: false, reason: 'invalid', message: '输入不对' } as const;
const DUPLICATE = { ok: false, reason: 'invalid', message: '这个分类已经有预算' } as const;

// ---------- 查询 ----------

// 本家庭的全部分类，含已归档的：老拆分可能还指向归档的分类
async function loadCategories(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
): Promise<BudgetCategory[]> {
  return tx
    .select({
      id: category.id,
      parentId: category.parentId,
      nameEn: category.nameEn,
      kind: category.kind,
      systemKey: category.systemKey,
      defaultMemberId: category.defaultMemberId,
      isPreTaxDefault: category.isPreTaxDefault,
      isOther: category.isOther,
      sortOrder: category.sortOrder,
      isArchived: category.isArchived,
    })
    .from(category)
    .where(eq(category.householdId, ctx.householdId))
    .orderBy(asc(category.sortOrder), asc(category.nameEn));
}

// today 所在自然月的拆分，pending 也算（R10）
async function loadMonthSplits(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
  today: string,
): Promise<StatSplit[]> {
  return tx
    .select({
      date: transaction.date,
      amountCents: transactionSplit.amountCents,
      categoryId: transactionSplit.categoryId,
      memberId: transactionSplit.memberId,
      isPreTax: transactionSplit.isPreTax,
    })
    .from(transactionSplit)
    .innerJoin(
      transaction,
      and(
        eq(transaction.id, transactionSplit.transactionId),
        eq(transaction.householdId, ctx.householdId),
      ),
    )
    .where(
      and(
        eq(transactionSplit.householdId, ctx.householdId),
        gte(transaction.date, startOfMonth(today)),
        lte(transaction.date, endOfMonth(today)),
      ),
    );
}

async function loadBudgets(tx: DbTx | typeof db, ctx: HouseholdContext) {
  return tx
    .select({
      id: budget.id,
      categoryId: budget.categoryId,
      monthlyLimitCents: budget.monthlyLimitCents,
      warnAtPercent: budget.warnAtPercent,
      isPinned: budget.isPinned,
    })
    .from(budget)
    .where(eq(budget.householdId, ctx.householdId))
    .orderBy(asc(budget.createdAt), asc(budget.id));
}

// 分类 id → 排第几：一级按 sort_order，每个一级后面跟它的二级，现金支出排最后
// categories 已经按 sort_order 排好
function categoryRanks(categories: readonly BudgetCategory[]): Map<string, number> {
  const tops = categories.filter((c) => c.parentId === null);
  const ordered = [
    ...tops.filter((c) => c.systemKey !== 'cash_withdrawal'),
    ...tops.filter((c) => c.systemKey === 'cash_withdrawal'),
  ];
  const ranks = new Map<string, number>();
  for (const top of ordered) {
    ranks.set(top.id, ranks.size);
    for (const c of categories) if (c.parentId === top.id) ranks.set(c.id, ranks.size);
  }
  return ranks;
}

// R11.1、R11.3：设置页和首页用。本月、全家，不跟看板筛选
export async function listBudgetsWithProgress(
  ctx: HouseholdContext,
  today: string,
): Promise<BudgetsWithProgress> {
  return db.transaction(
    async (tx) => {
      const [rows, categories, splits] = await Promise.all([
        loadBudgets(tx, ctx),
        loadCategories(tx, ctx),
        loadMonthSplits(tx, ctx, today),
      ]);

      const overview = budgetOverview(rows, splits, categories, today);
      const progressById = new Map(overview.progress.map((p) => [p.budgetId, p]));
      const byId = new Map(categories.map((c) => [c.id, c]));
      const budgeted = new Set(rows.map((b) => b.categoryId));
      const ranks = categoryRanks(categories);

      const budgets = rows.map((b): BudgetItem => {
        const c = byId.get(b.categoryId)!;
        const parent = c.parentId ? byId.get(c.parentId)! : null;
        return {
          ...b,
          parentId: c.parentId,
          label: parent ? `${parent.nameEn} / ${c.nameEn}` : c.nameEn,
          progress: progressById.get(b.id)!,
          includedIn: parent && budgeted.has(parent.id) ? parent.id : null,
        };
      });
      budgets.sort((a, b) => ranks.get(a.categoryId)! - ranks.get(b.categoryId)!);

      return { budgets, overview };
    },
    { accessMode: 'read only' },
  );
}

// ---------- 写入 ----------

const percentSchema = z.number().int().min(1).max(100);
const limitSchema = z.string().max(100);

const createSchema = z.object({
  categoryId: z.uuid(),
  monthlyLimit: limitSchema, // 元，"200.00"
  warnAtPercent: percentSchema.default(80),
  isPinned: z.boolean().default(false),
});

// 没有 categoryId：编辑不能换分类，要换就删掉重建（Zod 默认去掉多余的字段）
const updateSchema = z.object({
  monthlyLimit: limitSchema.optional(),
  warnAtPercent: percentSchema.optional(),
  isPinned: z.boolean().optional(),
});

export type CreateBudgetInput = z.input<typeof createSchema>;
export type UpdateBudgetInput = z.input<typeof updateSchema>;

// 元 → 分，必须 > 0（schema check）。格式不对返回 null
function parseLimit(input: string): number | null {
  try {
    const cents = parseAmountToCents(input);
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

const LIMIT_INVALID = { ok: false, reason: 'invalid', message: '每月上限要大于 0' } as const;

// 唯一约束 (household_id, category_id)：两次保存同时撞上时的兜底。drizzle 把驱动错误包在 cause 里
function isBudgetUniqueViolation(err: unknown): boolean {
  const pgError = (err as { cause?: unknown })?.cause ?? err;
  const { code, constraint } = (pgError ?? {}) as { code?: string; constraint?: string };
  return code === '23505' && constraint === 'budget_household_id_category_id_unique';
}

// R11.2：分类要属于本家庭、能设预算，而且还没有预算
export async function createBudget(
  ctx: HouseholdContext,
  input: CreateBudgetInput,
): Promise<BudgetWriteResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const data = parsed.data;
  const monthlyLimitCents = parseLimit(data.monthlyLimit);
  if (monthlyLimitCents === null) return LIMIT_INVALID;

  try {
    return await db.transaction(async (tx): Promise<BudgetWriteResult> => {
      const categories = await loadCategories(tx, ctx);
      const target = categories.find((c) => c.id === data.categoryId);
      if (!target) return CATEGORY_NOT_FOUND;
      if (!canHaveBudget(target, categories)) {
        return { ok: false, reason: 'invalid', message: '这个分类不能设预算' };
      }

      const [existing] = await tx
        .select({ id: budget.id })
        .from(budget)
        .where(and(eq(budget.householdId, ctx.householdId), eq(budget.categoryId, target.id)));
      if (existing) return DUPLICATE;

      const [created] = await tx
        .insert(budget)
        .values({
          householdId: ctx.householdId,
          categoryId: target.id,
          monthlyLimitCents,
          warnAtPercent: data.warnAtPercent,
          isPinned: data.isPinned,
        })
        .returning({ id: budget.id });
      return { ok: true, budgetId: created.id };
    });
  } catch (err) {
    if (!isBudgetUniqueViolation(err)) throw err;
    return DUPLICATE;
  }
}

// 改上限、提醒百分比、固定。不能改分类
export async function updateBudget(
  ctx: HouseholdContext,
  budgetId: string,
  input: UpdateBudgetInput,
): Promise<BudgetWriteResult> {
  if (!z.uuid().safeParse(budgetId).success) return BUDGET_NOT_FOUND;
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const { monthlyLimit, ...rest } = parsed.data;

  const patch: Partial<typeof budget.$inferInsert> = rest;
  if (monthlyLimit !== undefined) {
    const cents = parseLimit(monthlyLimit);
    if (cents === null) return LIMIT_INVALID;
    patch.monthlyLimitCents = cents;
  }
  return writeBudget(ctx, budgetId, patch);
}

export async function setBudgetPinned(
  ctx: HouseholdContext,
  budgetId: string,
  isPinned: boolean,
): Promise<BudgetWriteResult> {
  if (!z.uuid().safeParse(budgetId).success) return BUDGET_NOT_FOUND;
  return writeBudget(ctx, budgetId, { isPinned });
}

// R11.3：硬删除
export async function deleteBudget(
  ctx: HouseholdContext,
  budgetId: string,
): Promise<BudgetWriteResult> {
  if (!z.uuid().safeParse(budgetId).success) return BUDGET_NOT_FOUND;
  const [row] = await db
    .delete(budget)
    .where(and(eq(budget.id, budgetId), eq(budget.householdId, ctx.householdId)))
    .returning({ id: budget.id });
  return row ? { ok: true, budgetId: row.id } : BUDGET_NOT_FOUND;
}

// 改本家庭的一个预算；patch 是空的时只确认它存在
async function writeBudget(
  ctx: HouseholdContext,
  budgetId: string,
  patch: Partial<typeof budget.$inferInsert>,
): Promise<BudgetWriteResult> {
  const where = and(eq(budget.id, budgetId), eq(budget.householdId, ctx.householdId));
  const [row] =
    Object.keys(patch).length > 0
      ? await db.update(budget).set(patch).where(where).returning({ id: budget.id })
      : await db.select({ id: budget.id }).from(budget).where(where);
  return row ? { ok: true, budgetId: row.id } : BUDGET_NOT_FOUND;
}
