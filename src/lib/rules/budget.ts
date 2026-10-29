// 预算总览和能设预算的分类（business-rules.md R11.1、R11.2）
// 支出口径和单个预算的进度复用 stats.ts（R10、R11）
// 纯函数，不 import 数据库和 Next.js
import { endOfMonth, startOfMonth } from './periods';
import type { EditCategory } from './split-edit';
import {
  bucketOf,
  budgetProgress,
  indexCategories,
  type BudgetInput,
  type BudgetProgress,
  type StatSplit,
} from './stats';
import type { Category } from './types';

// ---------- R11.2 ----------

// R11.2：kind = expense 的一级和二级（归档的除外，一级归档时二级也不行）+ 系统分类现金支出
export function canHaveBudget(c: EditCategory, categories: readonly EditCategory[]): boolean {
  if (c.isArchived) return false;
  if (c.parentId !== null) {
    const parent = categories.find((p) => p.id === c.parentId);
    if (!parent || parent.isArchived) return false;
  }
  return c.kind === 'expense' || c.systemKey === 'cash_withdrawal';
}

// ---------- R11.1 ----------

export type UncoveredCategory = {
  categoryId: string; // 一级
  label: string; // 一级名字；isOther 时是 "X（其他）"
  isOther: boolean; // 一级没有预算、但部分二级有
  cents: number; // 支出为正数，可能为负（退款大于支出）
};

export type BudgetOverview = {
  limitCents: number; // Σ 最外层预算的上限
  spentCents: number; // Σ 最外层预算的本月支出
  remainingCents: number; // 上限 − 已花，可以是负数
  uncovered: UncoveredCategory[]; // 不被任何预算覆盖的本月支出，按一级，金额从大到小，0 不列
  progress: BudgetProgress[]; // 每个预算自己的进度（含被一级包含的二级预算），顺序同输入
};

// R11.1：只看 today 所在的自然月；自检：spentCents + Σ uncovered = R10 本月支出
export function budgetOverview(
  budgets: readonly BudgetInput[],
  splits: readonly StatSplit[],
  categories: readonly Category[],
  today: string,
): BudgetOverview {
  const idx = indexCategories(categories);
  const progress = budgetProgress(budgets, splits, categories, today);
  const budgeted = new Set(budgets.map((b) => b.categoryId));

  // R11.1：二级预算的一级也有预算时，二级已经包含在一级里，不进合计
  let limitCents = 0;
  let spentCents = 0;
  for (const p of progress) {
    const top = idx.topOf(p.categoryId);
    if (top !== p.categoryId && budgeted.has(top)) continue;
    limitCents += p.limitCents;
    spentCents += p.spentCents;
  }

  // 没被覆盖的支出按一级合计；一级有预算时它下面全被覆盖，二级有预算时只覆盖这个二级
  const month = { start: startOfMonth(today), end: endOfMonth(today) };
  const uncoveredBy = new Map<string, number>();
  for (const s of splits) {
    if (s.date < month.start || s.date > month.end) continue;
    if (bucketOf(idx.get(s.categoryId)) !== 'expense') continue;
    const top = idx.topOf(s.categoryId);
    if (budgeted.has(top) || budgeted.has(s.categoryId)) continue;
    uncoveredBy.set(top, (uncoveredBy.get(top) ?? 0) - s.amountCents);
  }

  const hasBudgetedChild = new Set(
    budgets.map((b) => idx.get(b.categoryId).parentId).filter((id) => id !== null),
  );

  const uncovered = [...uncoveredBy.entries()]
    .filter(([, cents]) => cents !== 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([categoryId, cents]) => {
      const isOther = hasBudgetedChild.has(categoryId);
      const name = idx.get(categoryId).nameEn;
      return { categoryId, label: isOther ? `${name}（其他）` : name, isOther, cents };
    });

  return {
    limitCents,
    spentCents,
    remainingCents: limitCents - spentCents,
    uncovered,
    progress,
  };
}
