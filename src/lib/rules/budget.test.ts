import { describe, expect, it } from 'vitest';
import { processFile } from '@/lib/import/process';
import { readFixture } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { budgetOverview, canHaveBudget, type BudgetOverview } from './budget';
import { periodRange } from './periods';
import { summarize, type BudgetInput, type StatSplit } from './stats';

// 期望值来自 business-rules.md R11.1 场景 1、场景 2，R11.2；docs/tasks/m7.md M7-1
// 只导入 joint-2026-09.csv（fixtures/cases/01-joint-2026-09.md），今天 2026-09-30

const h = buildTestHousehold();
const TODAY = '2026-09-30';

function jointSplits(): StatSplit[] {
  const result = processFile(readFixture('anz/joint-2026-09.csv'), h.account('ANZ Joint'), h);
  if (!result.ok) throw new Error(result.message);
  return result.rows.map((r) => ({
    date: r.date,
    amountCents: r.amountCents,
    categoryId: r.categoryId,
    memberId: r.memberId,
    isPreTax: r.isPreTax,
  }));
}

const cat = (path: string) => h.category(path).id;

const budget = (path: string, monthlyLimitCents: number): BudgetInput => ({
  id: `budget:${path}`,
  categoryId: cat(path),
  monthlyLimitCents,
  warnAtPercent: 80,
});

const overview = (budgets: BudgetInput[], today = TODAY) =>
  budgetOverview(budgets, jointSplits(), h.categories, today);

// R10 本月支出
const monthExpense = (today = TODAY) =>
  summarize(jointSplits(), h.categories, periodRange('this_month', today)).expenseCents;

const uncoveredTotal = (o: BudgetOverview) => o.uncovered.reduce((a, u) => a + u.cents, 0);

const uncoveredRows = (o: BudgetOverview) =>
  o.uncovered.map(({ label, isOther, cents }) => ({ label, isOther, cents }));

describe('budgetOverview 场景 1（R11.1）', () => {
  const o = overview([
    budget('Groceries', 20000),
    budget('Entertainment & eat-out', 10000),
    budget('Entertainment & eat-out / Bubble tea', 500),
    budget('Cash withdrawal', 10000),
  ]);

  it('R11.1: second-level budget under a budgeted first-level is not added to the total', () => {
    expect(o.limitCents).toBe(40000);
  });

  it('R11.1: spent total covers the outermost budgets only', () => {
    expect(o.spentCents).toBe(37815);
  });

  it('R11.1: remaining = limit − spent', () => {
    expect(o.remainingCents).toBe(2185);
  });

  it('R11.1: uncovered lists first levels by amount, 0 skipped, negative last', () => {
    expect(uncoveredRows(o)).toEqual([
      { label: 'Home & utilities', isOther: false, cents: 9840 },
      { label: 'Transport & auto', isOther: false, cents: 2500 },
      { label: 'Personal & medical', isOther: false, cents: -4580 },
    ]);
    expect(o.uncovered.map((u) => u.categoryId)).toEqual([
      cat('Home & utilities'),
      cat('Transport & auto'),
      cat('Personal & medical'),
    ]);
  });

  it('R11.1: self-check spent + uncovered = R10 month expense', () => {
    expect(uncoveredTotal(o)).toBe(7760);
    expect(o.spentCents + uncoveredTotal(o)).toBe(monthExpense());
    expect(monthExpense()).toBe(45575);
  });

  it('R11.1: nested budget still shows its own progress (Bubble tea 180%, over)', () => {
    const p = o.progress.find((x) => x.categoryId === cat('Entertainment & eat-out / Bubble tea'));
    expect(p?.spentCents).toBe(900);
    expect(p?.percent).toBeCloseTo(180, 10);
    expect(p?.level).toBe('over');
  });

  it('R11.1: one over-budget eats the others (Cash withdrawal 150% but 2185 left)', () => {
    const p = o.progress.find((x) => x.categoryId === cat('Cash withdrawal'));
    expect(p?.percent).toBeCloseTo(150, 10);
    expect(p?.level).toBe('over');
    expect(o.remainingCents).toBeGreaterThan(0);
  });

  it('R11.1: progress is budgetProgress, one per budget in input order', () => {
    expect(o.progress.map((p) => p.budgetId)).toEqual([
      'budget:Groceries',
      'budget:Entertainment & eat-out',
      'budget:Entertainment & eat-out / Bubble tea',
      'budget:Cash withdrawal',
    ]);
  });
});

describe('budgetOverview 场景 2（R11.1）', () => {
  const o = overview([budget('Entertainment & eat-out / Bubble tea', 500)]);

  it('R11.1: only a second-level budget → it is the outermost', () => {
    expect(o.limitCents).toBe(500);
    expect(o.spentCents).toBe(900);
  });

  it('R11.1: remaining can be negative', () => {
    expect(o.remainingCents).toBe(-400);
  });

  it('R11.1: first level with some budgeted children is listed as "X（其他）"', () => {
    expect(uncoveredRows(o)).toEqual([
      { label: 'Groceries', isOther: false, cents: 15795 },
      { label: 'Cash withdrawal', isOther: false, cents: 15000 },
      { label: 'Home & utilities', isOther: false, cents: 9840 },
      { label: 'Entertainment & eat-out（其他）', isOther: true, cents: 6120 },
      { label: 'Transport & auto', isOther: false, cents: 2500 },
      { label: 'Personal & medical', isOther: false, cents: -4580 },
    ]);
  });

  it('R11.1: self-check spent + uncovered = R10 month expense', () => {
    expect(uncoveredTotal(o)).toBe(44675);
    expect(o.spentCents + uncoveredTotal(o)).toBe(monthExpense());
  });
});

describe('budgetOverview 没有预算（R11.1）', () => {
  const o = overview([]);

  it('R11.1: no budgets → limit 0, spent 0, remaining 0, no progress', () => {
    expect(o.limitCents).toBe(0);
    expect(o.spentCents).toBe(0);
    expect(o.remainingCents).toBe(0);
    expect(o.progress).toEqual([]);
  });

  it('R11.1: uncovered equals the whole month expense by first level (Bank fees 0 skipped)', () => {
    const s = summarize(jointSplits(), h.categories, periodRange('this_month', TODAY));
    expect(o.uncovered.map(({ categoryId, cents }) => ({ categoryId, cents }))).toEqual(
      s.expenseByCategory
        .filter((t) => t.cents !== 0)
        .map(({ categoryId, cents }) => ({ categoryId, cents })),
    );
    expect(o.uncovered.map((u) => u.categoryId)).not.toContain(cat('Bank fees'));
    expect(o.uncovered.every((u) => !u.isOther)).toBe(true);
    expect(uncoveredTotal(o)).toBe(45575);
  });
});

describe('budgetOverview 本月（R11.1）', () => {
  it('R11.1: only the calendar month of today counts', () => {
    const o = overview([budget('Groceries', 20000)], '2026-10-05');
    expect(o.spentCents).toBe(0);
    expect(o.remainingCents).toBe(20000);
    expect(o.uncovered).toEqual([]);
  });
});

describe('canHaveBudget（R11.2）', () => {
  const can = (path: string) => canHaveBudget(h.category(path), h.categories);

  it('R11.2: expense first and second levels can have a budget', () => {
    expect(can('Groceries')).toBe(true);
    expect(can('Groceries / Supermarket')).toBe(true);
  });

  it('R11.2: system category cash withdrawal can have a budget', () => {
    expect(can('Cash withdrawal')).toBe(true);
  });

  it('R11.2: income, bank fees, internal transfer, uncategorised cannot', () => {
    expect(can('Income')).toBe(false);
    expect(can('Income / Salary')).toBe(false);
    expect(can('Bank fees')).toBe(false);
    expect(can('Internal transfer')).toBe(false);
    expect(can('Uncategorised')).toBe(false);
  });

  it('R11.2: archived categories cannot', () => {
    const archived = { ...h.category('Groceries / Supermarket'), isArchived: true };
    expect(canHaveBudget(archived, h.categories)).toBe(false);
  });

  it('R11.2: second level under an archived first level cannot', () => {
    const categories = h.categories.map((c) =>
      c.id === cat('Groceries') ? { ...c, isArchived: true } : c,
    );
    expect(canHaveBudget(h.category('Groceries / Supermarket'), categories)).toBe(false);
  });
});
