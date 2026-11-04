import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import type { AccountNetInflow } from './balance';
import {
  actualSavings,
  affordability,
  emergencyTarget,
  fillByPriority,
  goalMonthlyRequired,
  goalSpend,
  monthlyRequired,
  monthsCovered,
  monthsUntil,
  nextCycle,
  projectedCompletion,
  type Goal,
  type GoalAccountBalance,
  type GoalProgress,
  type SavingsSplit,
} from './goals';
import { averageWindow, type MonthlyAverage } from './monthly-average';

// 期望值来自 docs/rules/R25-goal.md R25.2 到 R25.7、R25.9
// 和 fixtures/cases/16-goals.md 场景 A 到 G（今天 = 2026-12-15）

const TODAY = '2026-12-15';

const goal = (
  id: string,
  kind: Goal['kind'],
  targetCents: number,
  targetDate: string | null,
  accountId: string | null,
  priority: number,
  over: Partial<Goal> = {},
): Goal => ({
  id,
  kind,
  repeat: 'once',
  targetCents,
  targetDate,
  accountId,
  priority,
  emergencyMonths: null,
  status: 'active',
  ...over,
});

const emergency = (months: number, accountId: string | null = 'cba_saver'): Goal => ({
  id: 'E',
  kind: 'keep',
  repeat: 'once',
  targetCents: null,
  targetDate: null,
  accountId,
  priority: 0,
  emergencyMonths: months,
  status: 'active',
});

// 用例的"目标"表
const GOALS: Goal[] = [
  emergency(6),
  goal('G1', 'spend', 500000, '2027-03-20', 'anz_plus_male', 1),
  goal('G2', 'spend', 400000, '2027-06-10', 'anz_plus_male', 2),
  goal('G3', 'keep', 5000000, null, 'cba_saver', 3),
  goal('G4', 'spend', 150000, '2027-05-01', 'anz_card', 4),
  goal('G5', 'spend', 80000, '2027-03-15', 'anz_male', 5, { repeat: 'yearly' }),
  goal('G6', 'spend', 100000, '2027-02-15', 'cba_female', 6),
  goal('G7', 'spend', 150000, '2026-12-20', 'cba_female', 7, { status: 'done' }),
  goal('G8', 'spend', 250000, '2027-04-10', 'cba_female', 8),
  goal('G9', 'spend', 60000, '2026-12-24', null, 9),
  goal('G10', 'spend', 300000, '2026-11-30', null, 10),
  goal('G11', 'spend', 200000, '2027-08-01', 'boq', 11),
  goal('G12', 'spend', 50000, '2027-01-20', 'anz_old', 12),
  goal('G13', 'spend', 20000, '2028-02-29', null, 13, { repeat: 'yearly' }),
];

const ok = (availableCents: number): GoalAccountBalance => ({ archived: false, balance: { availableCents } });

// 用例的"可用余额"表
const BALANCES = new Map<string, GoalAccountBalance>([
  ['anz_plus_male', ok(700000)],
  ['anz_male', ok(50000)],
  ['cba_female', ok(300000)],
  ['cba_saver', ok(1559000)],
  ['anz_card', ok(-70000)],
  ['westpac', ok(0)],
  ['boq', { archived: false, balance: null }],
  ['anz_old', { archived: true, balance: null }],
]);

const average = (totalCents: number, months = 11): MonthlyAverage => ({
  months,
  totalCents,
  byCategory: [],
  byMember: [],
});

const E_TARGET = 2400000; // 400000 × 6

const byId = (rows: GoalProgress[]) => new Map(rows.map((r) => [r.goalId, r]));

const withGoals = (patch: (g: Goal) => Goal) => GOALS.map(patch);

// ---------- R25.2 monthsUntil ----------

describe('monthsUntil（R25.2）', () => {
  it('R25.2: target month itself is not counted (2026-11-03 → 2027-03-15 = 4)', () => {
    expect(monthsUntil('2027-03-15', '2026-11-03')).toBe(4);
  });

  it('R25.2 A-1: G2 2027-06 − 2026-12 = 6', () => {
    expect(monthsUntil('2027-06-10', TODAY)).toBe(6);
  });

  it('R25.2 A-1: G13 2028-02 − 2026-12 = 14', () => {
    expect(monthsUntil('2028-02-29', TODAY)).toBe(14);
  });

  it('R25.2 A-1: target month is this month → at least 1', () => {
    expect(monthsUntil('2026-12-24', TODAY)).toBe(1);
  });

  it('R25.2 A-2: target date = today is not expired', () => {
    expect(monthsUntil('2026-12-24', '2026-12-24')).toBe(1);
  });

  it('R25.2 A-2: target date < today → expired (null)', () => {
    expect(monthsUntil('2026-12-24', '2026-12-25')).toBeNull();
  });

  it('R25.2 A-1: G10 2026-11-30 expired', () => {
    expect(monthsUntil('2026-11-30', TODAY)).toBeNull();
  });
});

// ---------- R25.2 monthlyRequired ----------

describe('monthlyRequired（R25.2）', () => {
  it('R25.2 A-1: G2 200000 ÷ 6 rounds up to 33334', () => {
    expect(monthlyRequired(200000, '2027-06-10', TODAY)).toBe(33334);
  });

  it('R25.2 A-1: G4 150000 ÷ 5 divides evenly, no extra cent', () => {
    expect(monthlyRequired(150000, '2027-05-01', TODAY)).toBe(30000);
  });

  it('R25.2 A-1: G13 20000 ÷ 14 rounds up to 1429', () => {
    expect(monthlyRequired(20000, '2028-02-29', TODAY)).toBe(1429);
  });

  it('R25.2 A-1: G9 target month is this month → 60000 ÷ 1', () => {
    expect(monthlyRequired(60000, '2026-12-24', TODAY)).toBe(60000);
  });

  it('R25.2 A-1: already reached → 0', () => {
    expect(monthlyRequired(0, '2027-03-20', TODAY)).toBe(0);
  });

  it('R25.2 A-1: G10 expired and not reached → null', () => {
    expect(monthlyRequired(300000, '2026-11-30', TODAY)).toBeNull();
  });

  it('R25.2 A-2: G9 on 2026-12-24 → 60000; on 2026-12-25 → null', () => {
    expect(monthlyRequired(60000, '2026-12-24', '2026-12-24')).toBe(60000);
    expect(monthlyRequired(60000, '2026-12-24', '2026-12-25')).toBeNull();
  });

  it('R25.2 A-3: expired but reached → 0, not expired', () => {
    expect(monthlyRequired(0, '2026-12-01', TODAY)).toBe(0);
  });

  it('R25.2 B-2: G1 200000 ÷ 3 = 66667, G2 400000 ÷ 6 = 66667', () => {
    expect(monthlyRequired(200000, '2027-03-20', TODAY)).toBe(66667);
    expect(monthlyRequired(400000, '2027-06-10', TODAY)).toBe(66667);
  });
});

// ---------- R25.6 应急金 ----------

describe('emergencyTarget（R25.6）', () => {
  it('R25.6 E-1: 400000 × 6 = 2400000', () => {
    expect(emergencyTarget(average(400000), 6)).toBe(2400000);
  });

  it('R25.6 E-2: months 3 / 12 / 24', () => {
    expect(emergencyTarget(average(400000), 3)).toBe(1200000);
    expect(emergencyTarget(average(400000), 12)).toBe(4800000);
    expect(emergencyTarget(average(400000), 24)).toBe(9600000);
  });

  it('R25.6 E-3: average 429091 × 6 = 2574546', () => {
    expect(emergencyTarget(average(429091), 6)).toBe(2574546);
  });

  it('R25.6 E-4: no full month (null) → null', () => {
    expect(emergencyTarget(null, 6)).toBeNull();
  });

  it('R25.6 E-4: average = 0 → null', () => {
    expect(emergencyTarget(average(0), 6)).toBeNull();
  });

  it('R25.6: average < 0 → null', () => {
    expect(emergencyTarget(average(-100), 6)).toBeNull();
  });
});

describe('monthsCovered（R25.6，返回十分之一个月）', () => {
  it('R25.6 E-1: floor(15590000 ÷ 400000) = 38 → 3.8, not 3.9', () => {
    expect(monthsCovered(1559000, average(400000))).toBe(38);
  });

  it('R25.6 E-2: months 3, filled 1200000 → 30 (3.0)', () => {
    expect(monthsCovered(1200000, average(400000))).toBe(30);
  });

  it('R25.6 E-3: floor(15590000 ÷ 429091) = 36 → 3.6', () => {
    expect(monthsCovered(1559000, average(429091))).toBe(36);
  });

  it('R25.6 E-4: no average or average ≤ 0 → null ("—")', () => {
    expect(monthsCovered(1559000, null)).toBeNull();
    expect(monthsCovered(1559000, average(0))).toBeNull();
  });
});

// ---------- R25.3 fillByPriority ----------

describe('fillByPriority 基础数据（R25.3，用例 B-1）', () => {
  const rows = fillByPriority(GOALS, BALANCES, E_TARGET);
  const r = byId(rows);

  it('R25.3: done goals are left out', () => {
    expect(r.has('G7')).toBe(false);
    expect(rows).toHaveLength(13);
  });

  it('R25.3 B-1: prd example — $7000 fills bag $5000 then trip $2000', () => {
    expect(r.get('G1')).toMatchObject({ targetCents: 500000, filledCents: 500000, remainingCents: 0, reached: true });
    expect(r.get('G2')).toMatchObject({ targetCents: 400000, filledCents: 200000, remainingCents: 200000, reached: false });
  });

  it('R25.3 B-1: emergency fund always first in its account', () => {
    expect(r.get('E')).toMatchObject({ targetCents: 2400000, filledCents: 1559000, remainingCents: 841000, noProgress: null });
    expect(r.get('G3')).toMatchObject({ filledCents: 0, remainingCents: 5000000 });
  });

  it('R25.3 B-1: negative balance → 0', () => {
    expect(r.get('G4')).toMatchObject({ filledCents: 0, remainingCents: 150000, reached: false, noProgress: null });
  });

  it('R25.3 B-1: G5 gets 50000 of 80000', () => {
    expect(r.get('G5')).toMatchObject({ filledCents: 50000, remainingCents: 30000 });
  });

  it('R25.3 B-1: done G7 skipped, the rest 200000 goes to G8', () => {
    expect(r.get('G6')).toMatchObject({ filledCents: 100000, remainingCents: 0, reached: true });
    expect(r.get('G8')).toMatchObject({ filledCents: 200000, remainingCents: 50000 });
  });

  it('R25.3 B-1: account without anchor → no_balance, remaining = target', () => {
    expect(r.get('G11')).toMatchObject({ filledCents: null, remainingCents: 200000, reached: false, noProgress: 'no_balance' });
  });

  it('R25.3 B-1: archived account → archived, remaining = target', () => {
    expect(r.get('G12')).toMatchObject({ filledCents: null, remainingCents: 50000, noProgress: 'archived' });
  });

  it('R25.3 B-1: no account → no_account, remaining = target', () => {
    for (const [id, target] of [['G9', 60000], ['G10', 300000], ['G13', 20000]] as const) {
      expect(r.get(id)).toMatchObject({ filledCents: null, remainingCents: target, reached: false, noProgress: 'no_account' });
    }
  });
});

describe('fillByPriority + monthlyRequired（R25.2，用例 A-1）', () => {
  const r = byId(fillByPriority(GOALS, BALANCES, E_TARGET));
  const required = (id: string) => {
    const g = GOALS.find((x) => x.id === id)!;
    return monthlyRequired(r.get(id)!.remainingCents!, g.targetDate!, TODAY);
  };

  it('R25.2 A-1: monthly required per goal', () => {
    expect(required('G1')).toBe(0);
    expect(required('G2')).toBe(33334);
    expect(required('G4')).toBe(30000);
    expect(required('G5')).toBe(10000);
    expect(required('G6')).toBe(0);
    expect(required('G8')).toBe(12500);
    expect(required('G9')).toBe(60000);
    expect(required('G10')).toBeNull();
    expect(required('G11')).toBe(25000);
    expect(required('G12')).toBe(50000);
    expect(required('G13')).toBe(1429);
  });
});

describe('fillByPriority 变体（R25.3，用例 B-2 到 B-5）', () => {
  it('R25.3 B-2: balance 300000 not enough for G1 → G1 300000, G2 0', () => {
    const balances = new Map(BALANCES).set('anz_plus_male', ok(300000));
    const r = byId(fillByPriority(GOALS, balances, E_TARGET));
    expect(r.get('G1')).toMatchObject({ filledCents: 300000, remainingCents: 200000, reached: false });
    expect(r.get('G2')).toMatchObject({ filledCents: 0, remainingCents: 400000 });
  });

  it('R25.3 B-3: balance 0 → G4 filled 0', () => {
    const balances = new Map(BALANCES).set('anz_card', ok(0));
    const r = byId(fillByPriority(GOALS, balances, E_TARGET));
    expect(r.get('G4')).toMatchObject({ filledCents: 0, remainingCents: 150000, noProgress: null });
  });

  it('R25.3 B-4: G7 still active takes 150000, G8 gets 50000', () => {
    const goals = withGoals((g) => (g.id === 'G7' ? { ...g, status: 'active' } : g));
    const r = byId(fillByPriority(goals, BALANCES, E_TARGET));
    expect(r.get('G6')).toMatchObject({ filledCents: 100000, remainingCents: 0 });
    expect(r.get('G7')).toMatchObject({ filledCents: 150000, remainingCents: 0, reached: true });
    expect(r.get('G8')).toMatchObject({ filledCents: 50000, remainingCents: 200000 });
    expect(monthlyRequired(0, '2026-12-20', TODAY)).toBe(0);
    expect(monthlyRequired(200000, '2027-04-10', TODAY)).toBe(50000);
  });

  it('R25.3 B-5: G2 moved up → G2 400000, G1 300000', () => {
    const goals = withGoals((g) =>
      g.id === 'G1' ? { ...g, priority: 2 } : g.id === 'G2' ? { ...g, priority: 1 } : g,
    );
    const r = byId(fillByPriority(goals, BALANCES, E_TARGET));
    expect(r.get('G2')).toMatchObject({ filledCents: 400000, remainingCents: 0, reached: true });
    expect(r.get('G1')).toMatchObject({ filledCents: 300000, remainingCents: 200000 });
  });

  it('R25.3: order follows priority, not input order', () => {
    const r = byId(fillByPriority([...GOALS].reverse(), BALANCES, E_TARGET));
    expect(r.get('G1')).toMatchObject({ filledCents: 500000 });
    expect(r.get('E')).toMatchObject({ filledCents: 1559000 });
  });
});

describe('fillByPriority 应急金（R25.3、R25.6，用例 E-2、E-4、E-5）', () => {
  it('R25.6 E-2: months 3 → E reached and keeps 1200000, G3 gets 359000', () => {
    const r = byId(fillByPriority(withGoals((g) => (g.id === 'E' ? emergency(3) : g)), BALANCES, 1200000));
    expect(r.get('E')).toMatchObject({ targetCents: 1200000, filledCents: 1200000, remainingCents: 0, reached: true });
    expect(r.get('G3')).toMatchObject({ filledCents: 359000 });
  });

  it('R25.6 E-2: months 12 → E 1559000, G3 0', () => {
    const r = byId(fillByPriority(withGoals((g) => (g.id === 'E' ? emergency(12) : g)), BALANCES, 4800000));
    expect(r.get('E')).toMatchObject({ targetCents: 4800000, filledCents: 1559000, remainingCents: 3241000 });
    expect(r.get('G3')).toMatchObject({ filledCents: 0 });
  });

  it('R25.6 E-4: no average → E takes no money, shows no_average; G3 gets 1559000', () => {
    const r = byId(fillByPriority(GOALS, BALANCES, null));
    expect(r.get('E')).toMatchObject({ targetCents: null, filledCents: null, remainingCents: null, reached: false, noProgress: 'no_average' });
    expect(r.get('G3')).toMatchObject({ filledCents: 1559000, remainingCents: 3441000 });
  });

  it('R25.6 E-5: emergency without account → target only, G3 gets 1559000', () => {
    const r = byId(fillByPriority(withGoals((g) => (g.id === 'E' ? emergency(6, null) : g)), BALANCES, E_TARGET));
    expect(r.get('E')).toMatchObject({ targetCents: 2400000, filledCents: null, noProgress: 'no_account' });
    expect(r.get('G3')).toMatchObject({ filledCents: 1559000, remainingCents: 3441000 });
  });
});

// ---------- R25.2 每月要存合计 ----------

describe('goalMonthlyRequired + affordability 合计（R25.2，用例 A-1）', () => {
  const progress = fillByPriority(GOALS, BALANCES, E_TARGET);
  const required = goalMonthlyRequired(GOALS, progress, TODAY);

  it('R25.2 A-1: per goal; no date / expired → null', () => {
    expect(Object.fromEntries(required)).toEqual({
      E: null,
      G1: 0,
      G2: 33334,
      G3: null,
      G4: 30000,
      G5: 10000,
      G6: 0,
      G8: 12500,
      G9: 60000,
      G10: null,
      G11: 25000,
      G12: 50000,
      G13: 1429,
    });
  });

  it('R25.2 A-1: done G7 not included', () => {
    expect(required.has('G7')).toBe(false);
  });

  it('R25.2 A-1: total = 222263, expired G10 left out', () => {
    expect(affordability(required, 193333).requiredTotalCents).toBe(222263);
  });

  it('R25.2 E-4: emergency without average has no monthly required', () => {
    const r = goalMonthlyRequired(GOALS, fillByPriority(GOALS, BALANCES, null), TODAY);
    expect(r.get('E')).toBeNull();
  });
});

// ---------- R25.4 预计达成 ----------

const INFLOW = new Map<string, AccountNetInflow | null>([
  ['anz_plus_male', { months: 3, totalCents: 90000 }],
  ['cba_saver', { months: 3, totalCents: 63000 }],
  ['anz_card', { months: 1, totalCents: -20000 }],
  ['anz_male', { months: 3, totalCents: 0 }],
  ['cba_female', { months: 1, totalCents: 70000 }],
  ['westpac', null],
]);

const project = (goals: Goal[], balances = BALANCES, inflow = INFLOW) =>
  projectedCompletion(goals, fillByPriority(goals, balances, E_TARGET), balances, inflow, TODAY);

describe('projectedCompletion 基础数据（R25.4，用例 C-1）', () => {
  const r = project(GOALS);

  it('R25.4 C-1: emergency first in Saver → 841000 × 3 ÷ 63000 → 41 months → 2030-05', () => {
    expect(r.get('E')).toEqual({ kind: 'projected', month: '2030-05', lateMonths: null });
  });

  it('R25.4 C-1: G3 waits for E → 5841000 → 279 months → 2050-03', () => {
    expect(r.get('G3')).toEqual({ kind: 'projected', month: '2050-03', lateMonths: null });
  });

  it('R25.4 C-1: G2 waits for G1 → 200000 → 7 months → 2027-07, 1 month late', () => {
    expect(r.get('G2')).toEqual({ kind: 'projected', month: '2027-07', lateMonths: 1 });
  });

  it('R25.4 C-1: G8 skips done G7 → 50000 → 1 month → 2027-01, not late', () => {
    expect(r.get('G8')).toEqual({ kind: 'projected', month: '2027-01', lateMonths: 0 });
  });

  it('R25.4 C-1: reached goals are not projected', () => {
    expect(r.get('G1')).toEqual({ kind: 'reached' });
    expect(r.get('G6')).toEqual({ kind: 'reached' });
  });

  it('R25.4 C-1: Σ < 0 (G4) and Σ = 0 (G5) → unreachable', () => {
    expect(r.get('G4')).toEqual({ kind: 'unreachable' });
    expect(r.get('G5')).toEqual({ kind: 'unreachable' });
  });

  it('R25.4 C-1: no account / no balance / archived → not projected', () => {
    for (const id of ['G9', 'G10', 'G13']) expect(r.get(id)).toEqual({ kind: 'no_progress', reason: 'no_account' });
    expect(r.get('G11')).toEqual({ kind: 'no_progress', reason: 'no_balance' });
    expect(r.get('G12')).toEqual({ kind: 'no_progress', reason: 'archived' });
  });

  it('R25.4: done G7 not included', () => {
    expect(r.has('G7')).toBe(false);
    expect(r.size).toBe(13);
  });
});

describe('projectedCompletion 变体（R25.4，用例 C-2 到 C-4）', () => {
  it('R25.4 C-2: balance 300000 → G1 2027-07 (4 late), G2 2028-08 (14 late)', () => {
    const balances = new Map(BALANCES).set('anz_plus_male', ok(300000));
    const r = project(GOALS, balances);
    expect(r.get('G1')).toEqual({ kind: 'projected', month: '2027-07', lateMonths: 4 });
    expect(r.get('G2')).toEqual({ kind: 'projected', month: '2028-08', lateMonths: 14 });
  });

  it('R25.4 C-3: projected month = target month is not late', () => {
    const r = project(withGoals((g) => (g.id === 'G2' ? { ...g, targetDate: '2027-07-31' } : g)));
    expect(r.get('G2')).toEqual({ kind: 'projected', month: '2027-07', lateMonths: 0 });
  });

  it('R25.4 C-4: G1 on Westpac (n = 0) → no_data; G2 alone on ANZ Plus is reached', () => {
    const r = project(withGoals((g) => (g.id === 'G1' ? { ...g, accountId: 'westpac' } : g)));
    expect(r.get('G1')).toEqual({ kind: 'no_data' });
    expect(r.get('G2')).toEqual({ kind: 'reached' });
  });

  it('R25.4: emergency without average takes no money and is not in Σ(target)', () => {
    const r = projectedCompletion(GOALS, fillByPriority(GOALS, BALANCES, null), BALANCES, INFLOW, TODAY);
    expect(r.get('E')).toEqual({ kind: 'no_progress', reason: 'no_average' });
    // G3：5000000 − 1559000 = 3441000 → ceil(10323000 ÷ 63000) = 164 → 2040-08
    expect(r.get('G3')).toEqual({ kind: 'projected', month: '2040-08', lateMonths: null });
  });
});

// ---------- R25.5 存不存得过来 ----------

const h = buildTestHousehold();
const MEMBER = h.members[0].id;

const split = (date: string, amountCents: number, path: string, goalId: string | null = null): SavingsSplit => ({
  date,
  amountCents,
  categoryId: h.category(path).id,
  memberId: MEMBER,
  isPreTax: false,
  goalId,
});

// 用例的"近 3 个月收支"：每月一笔收入凑出合计，支出用 Groceries 凑，11 月另有挂 G10 的 f1、j1、j2
function savingsSplits(income: [number, number, number] = [600000, 600000, 600000], linked = true): SavingsSplit[] {
  const goal = linked ? 'G10' : null;
  return [
    split('2026-09-01', income[0], 'Income / Salary'),
    split('2026-09-12', -420000, 'Groceries / Supermarket'),
    split('2026-10-01', income[1], 'Income / Salary'),
    split('2026-10-12', -380000, 'Groceries / Supermarket'),
    split('2026-11-01', income[2], 'Income / Salary'),
    split('2026-11-12', -420000, 'Groceries / Supermarket'),
    split('2026-11-05', -180000, 'Entertainment & eat-out / Holidays', goal),
    split('2026-11-18', -150000, 'Entertainment & eat-out / Holidays', goal),
    split('2026-11-28', 10000, 'Entertainment & eat-out / Holidays', goal),
    // 不算的：转账、未分类、窗口外
    { ...split('2026-10-10', -30000, 'Groceries / Supermarket'), categoryId: h.systemCategory('internal_transfer').id },
    { ...split('2026-10-11', -999, 'Groceries / Supermarket'), categoryId: h.systemCategory('uncategorized').id },
    split('2026-08-20', -500000, 'Groceries / Supermarket'),
    split('2026-12-03', -148000, 'Personal & medical / Computers & gadgets', 'G7'),
    split('2026-12-05', 300000, 'Income / Salary'),
  ];
}

const WINDOW_3 = averageWindow(TODAY, '2026-01-08', 3);

describe('actualSavings（R25.5，用例 D）', () => {
  it('R25.5 D-1: goal-linked splits excluded → 580000 ÷ 3 = 193333', () => {
    expect(actualSavings(savingsSplits(), WINDOW_3, h.categories)).toBe(193333);
  });

  it('R25.5 F-3: without goal links → 260000 ÷ 3 = 86667', () => {
    expect(actualSavings(savingsSplits(undefined, false), WINDOW_3, h.categories)).toBe(86667);
  });

  it('R25.5 D-2: Oct income 700000 → 226667', () => {
    expect(actualSavings(savingsSplits([600000, 700000, 600000]), WINDOW_3, h.categories)).toBe(226667);
  });

  it('R25.5 D-3: actual 0', () => {
    expect(actualSavings(savingsSplits([420000, 380000, 420000]), WINDOW_3, h.categories)).toBe(0);
  });

  it('R25.5 D-4: negative rounds by absolute value → −106667', () => {
    expect(actualSavings(savingsSplits([300000, 300000, 300000]), WINDOW_3, h.categories)).toBe(-106667);
  });

  it('R25.5 D-6: no full month → null', () => {
    expect(actualSavings(savingsSplits(), averageWindow(TODAY, '2026-12-01', 3), h.categories)).toBeNull();
  });
});

describe('affordability（R25.5，用例 D）', () => {
  const required = goalMonthlyRequired(GOALS, fillByPriority(GOALS, BALANCES, E_TARGET), TODAY);

  it('R25.5 D-1: 222263 > 193333 → short', () => {
    expect(affordability(required, 193333)).toEqual({ requiredTotalCents: 222263, actualCents: 193333, short: true });
  });

  it('R25.5 D-2: 226667 ≥ 222263 → not short', () => {
    expect(affordability(required, 226667).short).toBe(false);
  });

  it('R25.5: total = actual → not short', () => {
    expect(affordability(required, 222263).short).toBe(false);
  });

  it('R25.5 D-3: actual 0 → short', () => {
    expect(affordability(required, 0).short).toBe(true);
  });

  it('R25.5 D-4: actual negative → short', () => {
    expect(affordability(required, -106667).short).toBe(true);
  });

  it('R25.5 D-5: total 0 → not short even if actual is negative', () => {
    const kept = new Set(['E', 'G1', 'G3', 'G6', 'G10']);
    const goals = GOALS.filter((g) => kept.has(g.id));
    const r = goalMonthlyRequired(goals, fillByPriority(goals, BALANCES, E_TARGET), TODAY);
    expect(affordability(r, -106667)).toEqual({ requiredTotalCents: 0, actualCents: -106667, short: false });
  });

  it('R25.5 D-6: no full month → no comparison', () => {
    expect(affordability(required, null)).toEqual({ requiredTotalCents: 222263, actualCents: null, short: false });
  });
});

// ---------- R25.7 计划和实际 ----------

const linked = (goalId: string | null, amountCents: number) => ({ goalId, amountCents });

const LINKED = [
  linked('G10', -180000), // f1
  linked('G10', -150000), // j1
  linked('G10', 10000), // j2 退款
  linked('G7', -148000), // f2
  linked(null, -5000), // c2
];

const byGoal = (id: string) => GOALS.find((g) => g.id === id)!;

describe('goalSpend（R25.7，用例 F）', () => {
  it('R25.7 F-1: G10 plan 300000, actual 320000 (refund offsets), over by 20000, 3 splits', () => {
    expect(goalSpend(byGoal('G10'), LINKED)).toEqual({ planCents: 300000, actualCents: 320000, diffCents: 20000, count: 3 });
  });

  it('R25.7 F-1: G7 actual 148000, under by 2000', () => {
    expect(goalSpend(byGoal('G7'), LINKED)).toEqual({ planCents: 150000, actualCents: 148000, diffCents: -2000, count: 1 });
  });

  it('R25.7 F-1: nothing linked → actual 0, 0 splits', () => {
    expect(goalSpend(byGoal('G1'), LINKED)).toEqual({ planCents: 500000, actualCents: 0, diffCents: -500000, count: 0 });
  });

  it('R25.7: actual = plan → diff 0', () => {
    expect(goalSpend(byGoal('G1'), [linked('G1', -500000)]).diffCents).toBe(0);
  });

  it('R25.8 F-5: f1 moved to income (goal cleared) → G10 actual 140000, under by 160000', () => {
    const splits = LINKED.map((s, i) => (i === 0 ? { ...s, goalId: null } : s));
    expect(goalSpend(byGoal('G10'), splits)).toMatchObject({ actualCents: 140000, diffCents: -160000, count: 2 });
  });

  it('R25.8 F-5: split −50000 out of j1 → G10 actual 270000, under by 30000', () => {
    const splits = [linked('G10', -180000), linked('G10', -100000), linked(null, -50000), linked('G10', 10000)];
    expect(goalSpend(byGoal('G10'), splits)).toMatchObject({ actualCents: 270000, diffCents: -30000, count: 3 });
  });

  it('R25.7 F-6: done G7 unlinked → actual 0, under by 150000', () => {
    expect(goalSpend(byGoal('G7'), [])).toEqual({ planCents: 150000, actualCents: 0, diffCents: -150000, count: 0 });
  });
});

// ---------- R25.9 每年重复 ----------

describe('nextCycle（R25.9，用例 G）', () => {
  it('R25.9 G-2: G5 → next cycle 2028-03-15, same amount / account / priority, active, prev = G5', () => {
    expect(nextCycle(byGoal('G5'))).toEqual({
      kind: 'spend',
      repeat: 'yearly',
      targetCents: 80000,
      targetDate: '2028-03-15',
      accountId: 'anz_male',
      priority: 5,
      emergencyMonths: null,
      status: 'active',
      prevGoalId: 'G5',
    });
  });

  it('R25.9 G-2: G5′ filled 50000, monthly 2000; total 214263', () => {
    const goals = [
      ...withGoals((g) => (g.id === 'G5' ? { ...g, status: 'done' } : g)),
      { id: 'G5b', ...nextCycle(byGoal('G5')) },
    ];
    const progress = fillByPriority(goals, BALANCES, E_TARGET);
    expect(byId(progress).get('G5b')).toMatchObject({ filledCents: 50000, remainingCents: 30000 });
    const required = goalMonthlyRequired(goals, progress, TODAY);
    expect(required.get('G5b')).toBe(2000);
    expect(affordability(required, null).requiredTotalCents).toBe(214263);
  });

  it('R25.9 G-3: 2028-02-29 → 2029-02-28; monthly ceil(20000 ÷ 26) = 770', () => {
    const next = nextCycle(byGoal('G13'));
    expect(next.targetDate).toBe('2029-02-28');
    expect(monthlyRequired(20000, next.targetDate!, TODAY)).toBe(770);
  });

  it('R25.9: 02-28 stays 02-28 the year after', () => {
    expect(nextCycle({ ...byGoal('G13'), targetDate: '2029-02-28' }).targetDate).toBe('2030-02-28');
  });

  it('R25.9: once goal or no date → throws', () => {
    expect(() => nextCycle(byGoal('G1'))).toThrow();
    expect(() => nextCycle({ ...byGoal('G5'), targetDate: null })).toThrow();
  });
});
