// 目标和应急金（docs/rules/R25-goal.md）
// 进度、每月要存、预计达成、应急金金额每次实时算，不存。"今天"由调用方传进来
// 纯函数，不 import 数据库和 Next.js

import type { AccountNetInflow, CurrentBalance } from './balance';
import { roundDiv, type AverageWindow, type MonthlyAverage } from './monthly-average';
import { summarize, type StatSplit } from './stats';
import type { Category } from './types';

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

// YYYY-MM
function monthLabel(index: number): string {
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

// ceil(a ÷ b)，a ≥ 0、b > 0，整数算
function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
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
  return ceilDiv(remainingCents, months);
}

// R25.2：每个 active 目标的每月要存，顺序同 progress（fillByPriority 的结果）
// 没有日期、应急金算不出金额、已过期没达成 → null，不进合计
export function goalMonthlyRequired(
  goals: readonly Goal[],
  progress: readonly GoalProgress[],
  today: string,
): Map<string, number | null> {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const result = new Map<string, number | null>();
  for (const p of progress) {
    const date = byId.get(p.goalId)!.targetDate;
    result.set(
      p.goalId,
      date === null || p.remainingCents === null ? null : monthlyRequired(p.remainingCents, date, today),
    );
  }
  return result;
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

// ---------- R25.4 预计达成 ----------

export type Projection =
  | { kind: 'reached' } // 已存够，不估
  | { kind: 'no_progress'; reason: NoProgressReason } // 没挂账户、没锚点、已归档、应急金没有月均
  | { kind: 'no_data' } // 账户没有完整月，"数据不够，估不出来"
  | { kind: 'unreachable' } // 月净流入 ≤ 0，"按现在的速度达不到"
  // month 是 YYYY-MM；lateMonths：null = 没有日期，0 = 不晚，> 0 = 比目标晚 N 个月
  | { kind: 'projected'; month: string; lateMonths: number | null };

// R25.4：同一账户按 R25.3 的顺序，第 k 个要等 1 到 k 都填满
// 需要 = Σ(1..k 的目标金额) − 可用余额；月数 = ceil(需要 × n ÷ Σ)；预计 = 本月 + 月数
// progress 是 fillByPriority 的结果，顺序同它；inflowByAccount 是 accountNetInflow 的结果
export function projectedCompletion(
  goals: readonly Goal[],
  progress: readonly GoalProgress[],
  balancesByAccount: ReadonlyMap<string, GoalAccountBalance>,
  inflowByAccount: ReadonlyMap<string, AccountNetInflow | null>,
  today: string,
): Map<string, Projection> {
  const byId = new Map(progress.map((p) => [p.goalId, p]));
  const result = new Map<string, Projection>();

  const byAccount = new Map<string, Goal[]>();
  for (const g of goals) {
    const p = byId.get(g.id);
    if (!p) continue; // done 的不在 progress 里
    if (p.noProgress !== null) {
      result.set(g.id, { kind: 'no_progress', reason: p.noProgress });
      continue;
    }
    const list = byAccount.get(g.accountId!) ?? [];
    list.push(g);
    byAccount.set(g.accountId!, list);
  }

  const thisMonth = monthIndex(today);
  for (const [accountId, list] of byAccount) {
    const availableCents = balancesByAccount.get(accountId)!.balance!.availableCents;
    const inflow = inflowByAccount.get(accountId);
    if (inflow === undefined) throw new Error(`目标挂的账户没有传净流入: ${accountId}`);

    // 不占钱的应急金已经是 no_progress，不进 Σ(目标金额)
    let cumulative = 0;
    for (const g of [...list].sort(fillOrder)) {
      const p = byId.get(g.id)!;
      cumulative += p.targetCents!;
      if (p.reached) {
        result.set(g.id, { kind: 'reached' });
      } else if (inflow === null) {
        result.set(g.id, { kind: 'no_data' });
      } else if (inflow.totalCents <= 0) {
        result.set(g.id, { kind: 'unreachable' });
      } else {
        const need = cumulative - availableCents; // 没达成时一定 > 0
        const month = thisMonth + ceilDiv(need * inflow.months, inflow.totalCents);
        const lateMonths = g.targetDate === null ? null : Math.max(0, month - monthIndex(g.targetDate));
        result.set(g.id, { kind: 'projected', month: monthLabel(month), lateMonths });
      }
    }
  }

  return new Map(progress.map((p) => [p.goalId, result.get(p.goalId)!]));
}

// ---------- R25.5 存不存得过来 ----------

// goalId 不为空的只会是支出口径的拆分（R25.7、R25.8）
export type SavingsSplit = StatSplit & { goalId: string | null };

// R25.5：近 3 个完整月 Σ(收入 − 支出) ÷ n，口径同 R10，支出排除挂了目标的拆分
// window = averageWindow(today, 本家庭最早一笔交易的日期, 3)。没有完整月 → null
export function actualSavings(
  splits: readonly SavingsSplit[],
  window: AverageWindow,
  categories: readonly Category[],
): number | null {
  if (window.months === 0 || window.range === null) return null;
  const s = summarize(
    splits.filter((x) => x.goalId === null),
    categories,
    window.range,
  );
  return roundDiv(s.incomeCents - s.expenseCents, window.months);
}

export type Affordability = {
  requiredTotalCents: number; // 每月要存合计（R25.2），R25.10 也用这个
  actualCents: number | null; // 实际每月存下；null = 还没有完整月的数据
  short: boolean; // 显示"目标太多，或者日期往后推"
};

// R25.5：合计 > 0，而且（合计 > 实际，或者实际 ≤ 0）→ 提示。没有完整月不比较
// required 是 goalMonthlyRequired 的结果
export function affordability(
  required: ReadonlyMap<string, number | null>,
  actualCents: number | null,
): Affordability {
  let requiredTotalCents = 0;
  for (const cents of required.values()) if (cents !== null) requiredTotalCents += cents;
  const short =
    actualCents !== null && requiredTotalCents > 0 && (requiredTotalCents > actualCents || actualCents <= 0);
  return { requiredTotalCents, actualCents, short };
}

// ---------- R25.7 计划和实际 ----------

export type GoalSpend = {
  planCents: number; // 目标金额
  actualCents: number; // −Σ 挂上的拆分，退款冲减
  diffCents: number; // 实际 − 计划：> 0 多了，< 0 少了，0 刚好
  count: number; // 挂了几笔
};

// R25.7：splits 可以传全部挂了目标的拆分，这里按 goal.id 筛
export function goalSpend(
  goal: Pick<Goal, 'id' | 'targetCents'>,
  splits: readonly { goalId: string | null; amountCents: number }[],
): GoalSpend {
  if (goal.targetCents === null) throw new Error(`目标没有金额: ${goal.id}`);
  let actualCents = 0;
  let count = 0;
  for (const s of splits) {
    if (s.goalId !== goal.id) continue;
    actualCents -= s.amountCents;
    count += 1;
  }
  return { planCents: goal.targetCents, actualCents, diffCents: actualCents - goal.targetCents, count };
}

// ---------- R25.9 每年重复 ----------

// R25.9：yearly 完成时建的下一期。照抄类型、重复、金额、账户、优先级；日期 + 1 年，2 月 29 日 → 2 月 28 日
// 名字、固定到首页由数据层照抄
export function nextCycle(goal: Goal): Omit<Goal, 'id'> & { prevGoalId: string } {
  if (goal.repeat !== 'yearly') throw new Error(`不是每年重复的目标: ${goal.id}`);
  if (goal.targetDate === null) throw new Error(`每年重复的目标没有日期: ${goal.id}`);
  const year = String(Number(goal.targetDate.slice(0, 4)) + 1).padStart(4, '0');
  const monthDay = goal.targetDate.slice(5) === '02-29' ? '02-28' : goal.targetDate.slice(5);
  return {
    kind: goal.kind,
    repeat: goal.repeat,
    targetCents: goal.targetCents,
    targetDate: `${year}-${monthDay}`,
    accountId: goal.accountId,
    priority: goal.priority,
    emergencyMonths: goal.emergencyMonths,
    status: 'active',
    prevGoalId: goal.id,
  };
}
