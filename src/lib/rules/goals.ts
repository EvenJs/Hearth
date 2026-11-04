// 目标和应急金（docs/rules/R25-goal.md）
// 进度、每月要存、应急金金额每次实时算，不存。"今天"由调用方传进来
// 纯函数，不 import 数据库和 Next.js

import type { CurrentBalance } from './balance';
import type { MonthlyAverage } from './monthly-average';

export type GoalKind = 'keep' | 'spend';
export type GoalRepeat = 'once' | 'yearly';
export type GoalStatus = 'active' | 'done';

export type Goal = {
  id: string;
  kind: GoalKind;
  repeat: GoalRepeat;
  targetCents: number | null; // 应急金不填（R25.6 算）
  targetDate: string | null;
  accountId: string | null;
  priority: number;
  emergencyMonths: number | null; // 非 null = 应急金
  status: GoalStatus;
};

// archived 的账户不算余额（R23.2）；balance 为 null = 没有锚点
export type GoalAccountBalance = {
  archived: boolean;
  balance: Pick<CurrentBalance, 'availableCents'> | null;
};

export type NoProgressReason = 'no_account' | 'no_balance' | 'archived' | 'no_average';

export type GoalProgress = {
  goalId: string;
  targetCents: number | null; // 应急金是算出来的；算不出来是 null
  filledCents: number | null; // null = 没有进度，原因看 noProgress
  remainingCents: number | null; // 还差；没有进度 = 目标金额；应急金算不出金额是 null
  reached: boolean; // 还差 ≤ 0
  noProgress: NoProgressReason | null;
};

// 0 = 公元 0 年 1 月
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

// ---------- R25.2 每月要存 ----------

// R25.2：max(1, 目标月 − 本月)，目标月当月不算。目标日期 < 今天 → 已过期，null（= 今天不算过期）
export function monthsUntil(targetDate: string, today: string): number | null {
  if (targetDate < today) return null;
  return Math.max(1, monthIndex(targetDate) - monthIndex(today));
}

// R25.2：ceil(还差 ÷ 月数)，向上取整到分。已经达成 → 0（过期了也是）；已过期没达成 → null，不进合计
export function monthlyRequired(remainingCents: number, targetDate: string, today: string): number | null {
  if (remainingCents <= 0) return 0;
  const months = monthsUntil(targetDate, today);
  if (months === null) return null;
  return Math.floor((remainingCents + months - 1) / months);
}

// ---------- R25.6 应急金 ----------

// R25.6：近 12 个月总月均 × 月数。没有完整月或月均 ≤ 0 → null（"还没有月均"）
export function emergencyTarget(average: MonthlyAverage | null, months: number): number | null {
  if (average === null || average.totalCents <= 0) return null;
  return average.totalCents * months;
}

// R25.6：能撑几个月，向下取整到 0.1，返回十分之一个月（38 = 3.8 个月）。月均算不出来或 ≤ 0 → null（"—"）
export function monthsCovered(progressCents: number, average: MonthlyAverage | null): number | null {
  if (average === null || average.totalCents <= 0) return null;
  return Math.floor((progressCents * 10) / average.totalCents);
}

// ---------- R25.3 按优先级填进度 ----------

// R25.3：应急金第 1，其他按优先级从小到大
function fillOrder(a: Goal, b: Goal): number {
  const ea = a.emergencyMonths !== null ? 0 : 1;
  const eb = b.emergencyMonths !== null ? 0 : 1;
  if (ea !== eb) return ea - eb;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// R25.3：每个账户分开，用可用余额依次填 min(max(剩下的, 0), 目标金额)
// 只返回 active 的目标，顺序同 goals。emergencyTargetCents 是 emergencyTarget 的结果
export function fillByPriority(
  goals: readonly Goal[],
  balancesByAccount: ReadonlyMap<string, GoalAccountBalance>,
  emergencyTargetCents: number | null,
): GoalProgress[] {
  const active = goals.filter((g) => g.status === 'active');
  const result = new Map<string, GoalProgress>();

  const noProgress = (g: Goal, targetCents: number | null, reason: NoProgressReason): GoalProgress => ({
    goalId: g.id,
    targetCents,
    filledCents: null,
    remainingCents: targetCents,
    reached: false,
    noProgress: reason,
  });

  const byAccount = new Map<string, Goal[]>();
  for (const g of active) {
    const targetCents = g.emergencyMonths !== null ? emergencyTargetCents : g.targetCents;
    // R25.3 第 4 步：应急金算不出金额 → 不占钱
    if (targetCents === null) {
      result.set(g.id, noProgress(g, null, 'no_average'));
      continue;
    }
    if (g.accountId === null) {
      result.set(g.id, noProgress(g, targetCents, 'no_account'));
      continue;
    }
    const list = byAccount.get(g.accountId) ?? [];
    list.push(g);
    byAccount.set(g.accountId, list);
  }

  for (const [accountId, list] of byAccount) {
    const account = balancesByAccount.get(accountId);
    if (!account) throw new Error(`目标挂的账户没有传余额: ${accountId}`);
    const reason = account.archived ? 'archived' : account.balance === null ? 'no_balance' : null;

    let left = account.balance?.availableCents ?? 0;
    for (const g of [...list].sort(fillOrder)) {
      const targetCents = g.emergencyMonths !== null ? emergencyTargetCents! : g.targetCents!;
      if (reason !== null) {
        result.set(g.id, noProgress(g, targetCents, reason));
        continue;
      }
      const filledCents = Math.min(Math.max(left, 0), targetCents);
      left -= filledCents;
      const remainingCents = targetCents - filledCents;
      result.set(g.id, {
        goalId: g.id,
        targetCents,
        filledCents,
        remainingCents,
        reached: remainingCents <= 0,
        noProgress: null,
      });
    }
  }

  return active.map((g) => result.get(g.id)!);
}
