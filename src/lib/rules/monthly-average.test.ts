import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import {
  averageWindow,
  categoryAverage,
  compareToAverage,
  monthlyAverage,
  suggestedBudgetLimit,
  type AverageSplit,
  type AverageWindow,
} from './monthly-average';
import type { OneOffFlag } from './one-off';
import { filterByMember } from './stats';

// 期望值来自 docs/rules/R22-monthly-average.md R22.5 到 R22.9、R22.11
// 和 fixtures/cases/12-monthly-average.md 场景 A、W、R

const h = buildTestHousehold();
const cat = (path: string) => h.category(path).id;
const mem = (name: string) => h.member(name).id;

const TODAY = '2026-11-15';

const split = (
  date: string,
  amountCents: number,
  path: string,
  member: string,
  isOneOff: OneOffFlag = null,
): AverageSplit => ({ date, amountCents, categoryId: cat(path), memberId: mem(member), isOneOff });

// 场景 A（#20 是 pending，纯函数不看状态，照样计入）
const A: AverageSplit[] = [
  split('2026-06-10', 300000, 'Income / Salary', 'Female'),
  split('2026-06-12', -200000, 'Home & utilities / Rent', 'Home', false),
  split('2026-06-20', -9998, 'Groceries / Supermarket', 'Home'),
  split('2026-07-01', -200000, 'Home & utilities / Rent', 'Home', false),
  split('2026-07-15', -12000, 'Groceries / Supermarket', 'Home'),
  split('2026-07-20', -150000, 'Home & utilities / Furniture & appliances', 'Home', true),
  split('2026-08-01', -200000, 'Home & utilities / Rent', 'Home', false),
  split('2026-08-09', -9500, 'Groceries / Supermarket', 'Home'),
  split('2026-08-09', -1303, 'Groceries / Fruit', 'Home'),
  split('2026-08-25', 30000, 'Home & utilities / Furniture & appliances', 'Home', true),
  split('2026-09-01', -200000, 'Home & utilities / Rent', 'Home', false),
  split('2026-09-14', -11000, 'Groceries / Supermarket', 'Home'),
  split('2026-09-18', 4580, 'Personal & medical / Other', 'Female'),
  split('2026-09-20', -900, 'Entertainment & eat-out / Bubble tea', 'Male'),
  split('2026-09-28', -120000, 'Entertainment & eat-out / Holidays', 'Home', true),
  split('2026-10-01', -200000, 'Home & utilities / Rent', 'Home', false),
  split('2026-10-05', -13000, 'Groceries / Supermarket', 'Home'),
  split('2026-10-06', 500, 'Groceries / Supermarket', 'Home'),
  split('2026-10-12', -653, 'Entertainment & eat-out / Bubble tea', 'Male'),
  split('2026-10-15', -6001, 'Personal & medical / Clothing & shoes', 'Female'),
  split('2026-10-22', -50000, 'Internal transfer', 'Home'),
  split('2026-10-23', -2000, 'Uncategorised', 'Home'),
  split('2026-10-30', -5002, 'Cash withdrawal', 'Home'),
  split('2026-11-03', -14000, 'Groceries / Supermarket', 'Home'),
  split('2026-11-08', -80000, 'Home & utilities / Furniture & appliances', 'Home', true),
  split('2026-11-10', -450, 'Entertainment & eat-out / Bubble tea', 'Male'),
  split('2026-11-12', -3000, 'Transport & auto / Petrol / EV charging', 'Home'),
];
const FIRST = '2026-06-10';

const average = (splits: readonly AverageSplit[], window: AverageWindow) => {
  const result = monthlyAverage(splits, h.categories, h.members, window);
  if (!result) throw new Error('expected a monthly average');
  return result;
};

const named = (rows: { categoryId: string; cents: number }[]) =>
  rows.map((r) => [h.categories.find((c) => c.id === r.categoryId)!.nameEn, r.cents]);

const children = (result: ReturnType<typeof average>, path: string) =>
  named(result.byCategory.find((r) => r.categoryId === cat(path))!.children);

const members = (result: ReturnType<typeof average>) =>
  result.byMember.map((r) => [h.members.find((m) => m.id === r.memberId)!.name, r.cents]);

// 各一级、各归属人加起来 = 总月均；每个一级的二级加起来 = 一级
const expectConsistent = (result: ReturnType<typeof average>) => {
  const sum = (xs: { cents: number }[]) => xs.reduce((a, x) => a + x.cents, 0);
  expect(sum(result.byCategory)).toBe(result.totalCents);
  expect(sum(result.byMember)).toBe(result.totalCents);
  for (const row of result.byCategory) {
    if (row.children.length > 0) expect(sum(row.children)).toBe(row.cents);
  }
};

describe('averageWindow（R22.5，用例 W）', () => {
  it.each([
    ['W-1', TODAY, '2026-06-10', 12, '2026-06-01', '2026-10-31', 5],
    ['W-1', TODAY, '2026-06-10', 3, '2026-08-01', '2026-10-31', 3],
    ['W-2', TODAY, '2025-03-15', 12, '2025-11-01', '2026-10-31', 12],
    ['W-2', TODAY, '2025-03-15', 3, '2026-08-01', '2026-10-31', 3],
    ['W-3', TODAY, '2026-10-31', 12, '2026-10-01', '2026-10-31', 1],
    ['W-3', TODAY, '2026-10-31', 3, '2026-10-01', '2026-10-31', 1],
    ['W-5', '2026-11-01', '2026-06-10', 12, '2026-06-01', '2026-10-31', 5],
    ['W-5', '2026-11-01', '2026-06-10', 3, '2026-08-01', '2026-10-31', 3],
    ['W-6', '2027-01-05', '2026-06-10', 12, '2026-06-01', '2026-12-31', 7],
    ['W-6', '2027-01-05', '2026-06-10', 3, '2026-10-01', '2026-12-31', 3],
  ])(
    'R22.5 %s: today %s, first %s, last %i months → %s to %s, %i months',
    (_, today, first, months, start, end, n) => {
      expect(averageWindow(today, first, months)).toEqual({ months: n, range: { start, end } });
    },
  );

  it.each([12, 3])('R22.5 W-4: first transaction this month → 0 months (window %i)', (months) => {
    expect(averageWindow(TODAY, '2026-11-02', months)).toEqual({ months: 0, range: null });
  });

  it('R22.5: household without transactions → 0 months', () => {
    expect(averageWindow(TODAY, null, 12)).toEqual({ months: 0, range: null });
  });

  it('R22.5: 0 months → no average', () => {
    expect(monthlyAverage(A, h.categories, h.members, { months: 0, range: null })).toBeNull();
  });
});

describe('monthlyAverage 口径（R22.6，用例 A-1）', () => {
  // 一个月的窗口，月均 = 这个月的支出
  it.each([
    ['2026-06', '2026-06-30', 209998],
    ['2026-07', '2026-07-31', 212000],
    ['2026-08', '2026-08-31', 210803],
    ['2026-09', '2026-09-30', 207320],
    ['2026-10', '2026-10-31', 224156],
  ])(
    'R22.6 A-1: %s expense excludes one-off, transfer, uncategorised; refunds offset',
    (month, end, cents) => {
      const one: AverageWindow = { months: 1, range: { start: `${month}-01`, end } };
      expect(average(A, one).totalCents).toBe(cents);
    },
  );
});

describe('monthlyAverage 近 12 个月（R22.7，用例 A-2 到 A-4）', () => {
  const result = average(A, averageWindow(TODAY, FIRST, 12));

  it('R22.5 A-2: based on 5 months', () => {
    expect(result.months).toBe(5);
  });

  it('R22.7 A-2: total 1064277 ÷ 5 = 212855.4 → 212855', () => {
    expect(result.totalCents).toBe(212855);
  });

  it('R22.7 A-2: top-level by largest remainder, sorted by average desc', () => {
    expect(named(result.byCategory)).toEqual([
      ['Home & utilities', 200000],
      ['Groceries', 11260],
      ['Cash withdrawal', 1000],
      ['Entertainment & eat-out', 311],
      ['Personal & medical', 284],
    ]);
  });

  it('R22.7 A-3: Groceries children tie on remainder → larger s (Supermarket) first', () => {
    expect(children(result, 'Groceries')).toEqual([
      ['Supermarket', 11000],
      ['Fruit', 260],
    ]);
  });

  it('R22.7 A-3: negative child shown as is', () => {
    expect(children(result, 'Personal & medical')).toEqual([
      ['Clothing & shoes', 1200],
      ['Other', -916],
    ]);
  });

  it('R22.7 A-3: children with only one-off splits are not listed', () => {
    expect(children(result, 'Home & utilities')).toEqual([['Rent', 200000]]);
    expect(children(result, 'Entertainment & eat-out')).toEqual([['Bubble tea', 311]]);
  });

  it('R22.7 A-3: system categories have no children', () => {
    expect(children(result, 'Cash withdrawal')).toEqual([]);
  });

  it('R22.7 A-4: by member, Home and Male tie on remainder → larger s (Home) first', () => {
    expect(members(result)).toEqual([
      ['Home', 212261],
      ['Male', 310],
      ['Female', 284],
    ]);
  });

  it('R22.7: rows add up to the total, children add up to their top level', () => {
    expectConsistent(result);
  });
});

describe('monthlyAverage 近 3 个月（R22.5，用例 A-5）', () => {
  const result = average(A, averageWindow(TODAY, FIRST, 3));

  it('R22.5 A-5: based on 3 months, total 642279 ÷ 3 = 214093', () => {
    expect(result.months).toBe(3);
    expect(result.totalCents).toBe(214093);
  });

  it('R22.7 A-5: exact total still leaves k = 2 for the rows', () => {
    expect(named(result.byCategory)).toEqual([
      ['Home & utilities', 200000],
      ['Groceries', 11434],
      ['Cash withdrawal', 1667],
      ['Entertainment & eat-out', 518],
      ['Personal & medical', 474],
    ]);
  });

  it('R22.7 A-5: children, −4580 ÷ 3 floors to −1527 with remainder 1', () => {
    expect(children(result, 'Groceries')).toEqual([
      ['Supermarket', 11000],
      ['Fruit', 434],
    ]);
    expect(children(result, 'Personal & medical')).toEqual([
      ['Clothing & shoes', 2001],
      ['Other', -1527],
    ]);
  });

  it('R22.7 A-5: by member, all remainders 2 → Home, Male by larger s', () => {
    expect(members(result)).toEqual([
      ['Home', 213102],
      ['Male', 518],
      ['Female', 473],
    ]);
  });

  it('R22.7: rows add up to the total, children add up to their top level', () => {
    expectConsistent(result);
  });
});

describe('monthlyAverage 归属人筛选（R22.8，用例 A-6）', () => {
  const male = filterByMember(A, mem('Male'));

  it('R22.8 A-6: Male only, 12 months 1553 ÷ 5 → 311', () => {
    const result = average(male, averageWindow(TODAY, FIRST, 12));
    expect(result.totalCents).toBe(311);
    expect(named(result.byCategory)).toEqual([['Entertainment & eat-out', 311]]);
    expect(members(result)).toEqual([['Male', 311]]);
  });

  it('R22.8 A-6: Male only, 3 months 1553 ÷ 3 → 518', () => {
    expect(average(male, averageWindow(TODAY, FIRST, 3)).totalCents).toBe(518);
  });
});

describe('monthlyAverage 取整（R22.7，用例 R）', () => {
  const window = (months: number): AverageWindow => ({
    months,
    range: { start: '2026-08-01', end: '2026-10-31' },
  });

  it('R22.7 R-1: same remainder and same s → name order, Groceries first', () => {
    const result = average(
      [
        split('2026-09-01', -500, 'Groceries / Supermarket', 'Home'),
        split('2026-09-01', -500, 'Transport & auto / Petrol / EV charging', 'Home'),
      ],
      window(3),
    );
    expect(result.totalCents).toBe(333);
    expect(named(result.byCategory)).toEqual([
      ['Groceries', 167],
      ['Transport & auto', 166],
    ]);
  });

  it('R22.7 R-2: 1001 ÷ 2 = 500.5 → 501', () => {
    expect(
      average([split('2026-09-01', -1001, 'Groceries / Supermarket', 'Home')], window(2))
        .totalCents,
    ).toBe(501);
  });

  it('R22.7 R-3: −1001 ÷ 2 = −500.5 → −501 (round half away from zero)', () => {
    expect(
      average([split('2026-09-01', 1001, 'Groceries / Supermarket', 'Home')], window(2)).totalCents,
    ).toBe(-501);
  });

  it('R22.7 R-4: −1 mod 3 = 2 gets the cent → Groceries 333, Personal & medical 0', () => {
    const result = average(
      [
        split('2026-09-01', -1000, 'Groceries / Supermarket', 'Home'),
        split('2026-09-01', 1, 'Personal & medical / Other', 'Home'),
      ],
      window(3),
    );
    expect(result.totalCents).toBe(333);
    expect(named(result.byCategory)).toEqual([
      ['Groceries', 333],
      ['Personal & medical', 0],
    ]);
  });
});

describe('compareToAverage（R22.9，用例 A-7）', () => {
  it.each([
    ['total', 17450, 212855, -92],
    ['Home & utilities', 0, 200000, -100],
    ['Groceries', 14000, 11260, 24],
    ['Cash withdrawal', 0, 1000, -100],
    ['Entertainment & eat-out', 450, 311, 45],
    ['Personal & medical', 0, 284, -100],
    ['member Home', 17000, 212261, -92],
    ['member Male', 450, 310, 45],
    ['member Female', 0, 284, -100],
  ])('R22.9 A-7: %s %i vs %i → %i%', (_, current, avg, expected) => {
    expect(compareToAverage(current, avg)).toBe(expected);
  });

  it.each([
    ['Transport & auto', 3000, 0],
    ['Personal & medical / Other', 0, -916],
  ])('R22.9 A-7: %s average ≤ 0 → —', (_, current, avg) => {
    expect(compareToAverage(current, avg)).toBeNull();
  });
});

describe('suggestedBudgetLimit（R22.11，用例 A-10）', () => {
  const result = average(A, averageWindow(TODAY, FIRST, 12));

  it.each([
    ['Groceries', 11260, 11300],
    ['Groceries / Supermarket', 11000, 11000],
    ['Groceries / Fruit', 260, 300],
    ['Home & utilities', 200000, 200000],
    ['Cash withdrawal', 1000, 1000],
    ['Entertainment & eat-out', 311, 300],
  ])('R22.11 A-10: %s average %i → limit %i', (path, avg, limit) => {
    expect(categoryAverage(result, cat(path))).toBe(avg);
    expect(suggestedBudgetLimit(categoryAverage(result, cat(path)))).toBe(limit);
  });

  it.each([
    ['Entertainment & eat-out / Holidays', 0],
    ['Personal & medical / Other', -916],
    ['Transport & auto', 0],
  ])('R22.11 A-10: %s average %i → no default', (path, avg) => {
    expect(categoryAverage(result, cat(path))).toBe(avg);
    expect(suggestedBudgetLimit(categoryAverage(result, cat(path)))).toBeNull();
  });

  it('R22.11 W-4: no full month → no default', () => {
    const none = monthlyAverage(A, h.categories, h.members, averageWindow(TODAY, '2026-11-02', 12));
    expect(categoryAverage(none, cat('Groceries'))).toBeNull();
    expect(suggestedBudgetLimit(null)).toBeNull();
  });

  it.each([
    [15050, 15100],
    [15049, 15000],
  ])('R22.11 R: %i rounds to whole dollars → %i', (avg, limit) => {
    expect(suggestedBudgetLimit(avg)).toBe(limit);
  });
});
