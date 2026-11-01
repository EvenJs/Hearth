// 一次性标记和大额未标提示（business-rules.md R22.1、R22.3、R22.10）
// 一次性只是拆分上的标记，不改分类、归属人、金额；只影响月均（R22.5 起）
// 纯函数，不 import 数据库和 Next.js
import { bucketOf, indexCategories } from './stats';
import type { Category } from './types';

// R22.3：大额未标提示的阈值（$500）。prd 说可以改，目前就是改这个常量
export const ONE_OFF_HINT_CENTS = 50000;

// R22.1 transaction_split.is_one_off：null 没看过 / true 是 / false 看过，确认不是
// 统计里 null 和 false 一样，都不算一次性
export type OneOffFlag = boolean | null;

export type OneOffSplit = {
  amountCents: number;
  categoryId: string;
  isOneOff: OneOffFlag;
};

// R22.1：只有支出口径（R10）的拆分能标，正数（退款）也能标
export function canMarkOneOff(c: Category): boolean {
  return bucketOf(c) === 'expense';
}

// R22.3：一笔交易的拆分要不要提示"这笔是一次性开销吗？"
// 只看支出口径的拆分：有一个是 true 或 false 就算看过；全是 null 且合计 ≤ −阈值才提示
export function needsOneOffHint(
  splits: readonly OneOffSplit[],
  categories: readonly Category[],
): boolean {
  const idx = indexCategories(categories);
  const expense = splits.filter((s) => canMarkOneOff(idx.get(s.categoryId)));
  if (expense.some((s) => s.isOneOff !== null)) return false;
  const total = expense.reduce((sum, s) => sum + s.amountCents, 0);
  return total <= -ONE_OFF_HINT_CENTS;
}

// R22.10：本期"其中一次性 $X"，X = −Σ is_one_off = true 的支出口径拆分（退款冲减，可以是负数）
// 时间段和归属人（R10.6）由调用方先筛好
export function oneOffExpense(
  splits: readonly OneOffSplit[],
  categories: readonly Category[],
): number {
  const idx = indexCategories(categories);
  return splits
    .filter((s) => s.isOneOff === true && canMarkOneOff(idx.get(s.categoryId)))
    .reduce((sum, s) => sum - s.amountCents, 0);
}
