import { describe, expect, it } from 'vitest';
import {
  emergencyTarget,
  fillByPriority,
  monthlyRequired,
  monthsCovered,
  monthsUntil,
  type Goal,
  type GoalAccountBalance,
  type GoalProgress,
} from './goals';
import type { MonthlyAverage } from './monthly-average';

// 期望值来自 docs/rules/R25-goal.md R25.2、R25.3、R25.6
// 和 fixtures/cases/16-goals.md 场景 A、B、E（今天 = 2026-12-15）

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
