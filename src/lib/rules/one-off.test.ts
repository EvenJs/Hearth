import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import {
  canMarkOneOff,
  needsOneOffHint,
  oneOffExpense,
  ONE_OFF_HINT_CENTS,
  type OneOffFlag,
  type OneOffSplit,
} from './one-off';

// 期望值来自 docs/rules/R22-monthly-average.md R22.1、R22.3、R22.10
// 和 fixtures/cases/12-monthly-average.md 场景 A、A-8、H、O-17、O-18

const h = buildTestHousehold();
const cat = (path: string) => h.category(path).id;
const mem = (name: string) => h.member(name).id;
const INTERNAL = h.systemCategory('internal_transfer').id;
const UNCATEGORIZED = h.systemCategory('uncategorized').id;
const CASH = h.systemCategory('cash_withdrawal').id;
const BANK_FEE = h.systemCategory('bank_fee').id;

const FURNITURE = cat('Home & utilities / Furniture & appliances');
const SUPERMARKET = cat('Groceries / Supermarket');

const split = (amountCents: number, categoryId: string, isOneOff: OneOffFlag = null) => ({
  amountCents,
  categoryId,
  isOneOff,
});

describe('R22.1 一次性标记', () => {
  it('R22.3: hint threshold is $500', () => {
    expect(ONE_OFF_HINT_CENTS).toBe(50000);
  });

  it.each([
    ['Home & utilities / Furniture & appliances', true],
    ['Income / Salary', false],
    ['Income / Other', false],
  ])('R22.1: %s can be marked → %s', (path, expected) => {
    expect(canMarkOneOff(h.category(path))).toBe(expected);
  });

  it.each([
    ['cash_withdrawal', true],
    ['bank_fee', true],
    ['internal_transfer', false],
    ['uncategorized', false],
  ] as const)('R22.1 + O-18: system category %s can be marked → %s', (key, expected) => {
    expect(canMarkOneOff(h.systemCategory(key))).toBe(expected);
  });
});

describe('needsOneOffHint（R22.3，用例 H）', () => {
  const cases: [string, OneOffSplit[], boolean][] = [
    ['H-1 -600.00 Furniture null', [split(-60000, FURNITURE)], true],
    ['H-2 exactly -500.00', [split(-50000, FURNITURE)], true],
    ['H-3 -499.99 below threshold', [split(-49999, FURNITURE)], false],
    ['H-4 Rent marked false', [split(-200000, cat('Home & utilities / Rent'), false)], false],
    [
      'H-5 split, all expense splits null, total -800.00',
      [split(-30000, SUPERMARKET), split(-50000, FURNITURE)],
      true,
    ],
    [
      'H-6 one split false counts as reviewed',
      [split(-30000, SUPERMARKET, false), split(-50000, FURNITURE)],
      false,
    ],
    [
      'H-7 only -400.00 is expense, uncategorised not added',
      [split(-40000, SUPERMARKET), split(-30000, UNCATEGORIZED)],
      false,
    ],
    ['H-8 internal transfer', [split(-500000, INTERNAL)], false],
    ['H-9 uncategorised', [split(-90000, UNCATEGORIZED)], false],
    ['H-10 refund', [split(60000, FURNITURE)], false],
    [
      'H-11 pending still hinted',
      [split(-55000, cat('Personal & medical / Clothing & shoes'))],
      true,
    ],
    ['H-12 cash withdrawal is expense', [split(-60000, CASH)], true],
    ['H-13 income', [split(500000, cat('Income / Salary'))], false],
  ];

  it.each(cases)('R22.3 %s → %s', (_name, splits, expected) => {
    expect(needsOneOffHint(splits, h.categories)).toBe(expected);
  });

  it('R22.3: F8 quick filter "大额未标 5" (H-1, H-2, H-5, H-11, H-12)', () => {
    const hinted = cases.filter(([, splits]) => needsOneOffHint(splits, h.categories));
    expect(hinted.map(([name]) => name.split(' ')[0])).toEqual([
      'H-1',
      'H-2',
      'H-5',
      'H-11',
      'H-12',
    ]);
  });

  it('R22.3: H-5 after "不是一次性" (both false) → no hint, 4 left', () => {
    const after = [split(-30000, SUPERMARKET, false), split(-50000, FURNITURE, false)];
    expect(needsOneOffHint(after, h.categories)).toBe(false);
    const rest = cases.filter(([name]) => !name.startsWith('H-5 '));
    expect(rest.filter(([, s]) => needsOneOffHint(s, h.categories))).toHaveLength(4);
  });

  it('R22.3: H-5 after "是" (both true) → no hint', () => {
    const after = [split(-30000, SUPERMARKET, true), split(-50000, FURNITURE, true)];
    expect(needsOneOffHint(after, h.categories)).toBe(false);
  });

  it('R22.3: bank fee is expense too', () => {
    expect(needsOneOffHint([split(-50000, BANK_FEE)], h.categories)).toBe(true);
  });

  it('R22.3: unknown category → throws', () => {
    expect(() => needsOneOffHint([split(-60000, 'nope')], h.categories)).toThrow();
  });
});

// ---------- 场景 A ----------

type Row = OneOffSplit & { no: number; date: string; memberId: string };

const Y = true;
const N = false;
const _ = null;

// fixtures/cases/12-monthly-average.md 场景 A：一笔交易一个拆分
const A: Row[] = (
  [
    [1, '2026-06-10', 300000, 'Income / Salary', 'Female', _],
    [2, '2026-06-12', -200000, 'Home & utilities / Rent', 'Home', N],
    [3, '2026-06-20', -9998, 'Groceries / Supermarket', 'Home', _],
    [4, '2026-07-01', -200000, 'Home & utilities / Rent', 'Home', N],
    [5, '2026-07-15', -12000, 'Groceries / Supermarket', 'Home', _],
    [6, '2026-07-20', -150000, 'Home & utilities / Furniture & appliances', 'Home', Y],
    [7, '2026-08-01', -200000, 'Home & utilities / Rent', 'Home', N],
    [8, '2026-08-09', -9500, 'Groceries / Supermarket', 'Home', _],
    [9, '2026-08-09', -1303, 'Groceries / Fruit', 'Home', _],
    [10, '2026-08-25', 30000, 'Home & utilities / Furniture & appliances', 'Home', Y],
    [11, '2026-09-01', -200000, 'Home & utilities / Rent', 'Home', N],
    [12, '2026-09-14', -11000, 'Groceries / Supermarket', 'Home', _],
    [13, '2026-09-18', 4580, 'Personal & medical / Other', 'Female', _],
    [14, '2026-09-20', -900, 'Entertainment & eat-out / Bubble tea', 'Male', _],
    [15, '2026-09-28', -120000, 'Entertainment & eat-out / Holidays', 'Home', Y],
    [16, '2026-10-01', -200000, 'Home & utilities / Rent', 'Home', N],
    [17, '2026-10-05', -13000, 'Groceries / Supermarket', 'Home', _],
    [18, '2026-10-06', 500, 'Groceries / Supermarket', 'Home', _],
    [19, '2026-10-12', -653, 'Entertainment & eat-out / Bubble tea', 'Male', _],
    [20, '2026-10-15', -6001, 'Personal & medical / Clothing & shoes', 'Female', _],
    [21, '2026-10-22', -50000, 'internal_transfer', 'Home', _],
    [22, '2026-10-23', -2000, 'uncategorized', 'Home', _],
    [23, '2026-10-30', -5002, 'cash_withdrawal', 'Home', _],
    [24, '2026-11-03', -14000, 'Groceries / Supermarket', 'Home', _],
    [25, '2026-11-08', -80000, 'Home & utilities / Furniture & appliances', 'Home', Y],
    [26, '2026-11-10', -450, 'Entertainment & eat-out / Bubble tea', 'Male', _],
    [27, '2026-11-12', -3000, 'Transport & auto / Petrol / EV charging', 'Home', _],
  ] as const
).map(([no, date, amountCents, category, member, isOneOff]) => ({
  no,
  date,
  amountCents,
  categoryId: category.includes(' / ')
    ? cat(category)
    : h.systemCategory(category as 'internal_transfer' | 'uncategorized' | 'cash_withdrawal').id,
  memberId: mem(member),
  isOneOff,
}));

const between = (start: string, end: string, member?: string) =>
  A.filter(
    (r) => r.date >= start && r.date <= end && (member === undefined || r.memberId === mem(member)),
  );

describe('needsOneOffHint 场景 A（R22.3）', () => {
  it('R22.3: nothing in scenario A is hinted (large ones are marked, #21 is a transfer)', () => {
    expect(A.filter((r) => needsOneOffHint([r], h.categories)).map((r) => r.no)).toEqual([]);
  });
});

describe('oneOffExpense（R22.10，用例 A-8）', () => {
  it.each([
    ['本月 11-01 to 11-15, all', '2026-11-01', '2026-11-15', undefined, 80000],
    ['本月, Male → 0, row hidden', '2026-11-01', '2026-11-15', 'Male', 0],
    ['2026-07-01 to 2026-08-31 (#6, #10)', '2026-07-01', '2026-08-31', undefined, 120000],
    ['2026-08 only the refund → negative', '2026-08-01', '2026-08-31', undefined, -30000],
    ['2026-10 → 0, row hidden', '2026-10-01', '2026-10-31', undefined, 0],
    ['本财年 2026-07-01 to 11-15', '2026-07-01', '2026-11-15', undefined, 320000],
  ])('R22.10: %s → %d', (_name, start, end, member, expected) => {
    expect(oneOffExpense(between(start, end, member), h.categories)).toBe(expected);
  });

  it('R22.10: no splits → 0', () => {
    expect(oneOffExpense([], h.categories)).toBe(0);
  });

  it('R22.1 + O-17: a positive refund marked true is counted (offsets)', () => {
    expect(oneOffExpense([split(30000, FURNITURE, true)], h.categories)).toBe(-30000);
  });
});
