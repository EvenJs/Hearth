// M7.7-6 F8 一次性筛选和大额未标（business-rules.md R22.3、R22.4、R16.5）
// 期望值来自 fixtures/cases/12-monthly-average.md 场景 A（A-9）和 H
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { OneOffFlag } from '@/lib/rules/one-off';
import type { TransactionFilters } from '@/lib/transactions/filters';
import { dismissOneOffHint } from '@/server/splits';
import { countQuickFilters, listTransactions } from '@/server/transactions';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

// fixtures/cases/12：今天 = 2026-11-15
const TODAY = '2026-11-15';

let t: DbTestHousehold;

type SplitRow = [amountCents: number, category: string, isOneOff: OneOffFlag, member?: string];

// 用例的 # 写在 merchant 上，方便按名字找。拆分第一个是主拆分
async function insertTx(
  name: string,
  date: string,
  splits: SplitRow[],
  status: 'confirmed' | 'pending' = 'confirmed',
): Promise<string> {
  const { ctx, h } = t;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.transaction)
      .values({
        householdId: ctx.householdId,
        accountId: h.account('ANZ Joint').id,
        date,
        amountCents: splits.reduce((s, [a]) => s + a, 0),
        rawDescription: name,
        merchant: name,
        status,
        source: 'manual',
        createdBy: ctx.userId,
      })
      .returning({ id: schema.transaction.id });
    await tx.insert(schema.transactionSplit).values(
      splits.map(([amountCents, category, isOneOff, memberName], i) => ({
        householdId: ctx.householdId,
        transactionId: row.id,
        amountCents,
        categoryId: h.category(category).id,
        memberId: h.member(memberName ?? 'Home').id,
        categorySource: 'manual',
        memberSource: 'manual',
        isPrimary: i === 0,
        isPreTax: false,
        isOneOff,
      })),
    );
    return row.id;
  });
}

const list = (filters: TransactionFilters) =>
  listTransactions(t.ctx, filters, { today: TODAY, pageSize: 200 });

const names = (r: Awaited<ReturnType<typeof list>>) => r.items.map((i) => i.merchant).sort();

const FURNITURE = 'Home & utilities / Furniture & appliances';
const SUPERMARKET = 'Groceries / Supermarket';

// ---------- 场景 A（A-9） ----------

const SCENARIO_A: [string, string, SplitRow][] = [
  ['#1', '2026-06-10', [300000, 'Income / Salary', null, 'Female']],
  ['#2', '2026-06-12', [-200000, 'Home & utilities / Rent', false]],
  ['#3', '2026-06-20', [-9998, SUPERMARKET, null]],
  ['#4', '2026-07-01', [-200000, 'Home & utilities / Rent', false]],
  ['#5', '2026-07-15', [-12000, SUPERMARKET, null]],
  ['#6', '2026-07-20', [-150000, FURNITURE, true]],
  ['#7', '2026-08-01', [-200000, 'Home & utilities / Rent', false]],
  ['#8', '2026-08-09', [-9500, SUPERMARKET, null]],
  ['#9', '2026-08-09', [-1303, 'Groceries / Fruit', null]],
  ['#10', '2026-08-25', [30000, FURNITURE, true]],
  ['#11', '2026-09-01', [-200000, 'Home & utilities / Rent', false]],
  ['#12', '2026-09-14', [-11000, SUPERMARKET, null]],
  ['#13', '2026-09-18', [4580, 'Personal & medical / Other', null, 'Female']],
  ['#14', '2026-09-20', [-900, 'Entertainment & eat-out / Bubble tea', null, 'Male']],
  ['#15', '2026-09-28', [-120000, 'Entertainment & eat-out / Holidays', true]],
  ['#16', '2026-10-01', [-200000, 'Home & utilities / Rent', false]],
  ['#17', '2026-10-05', [-13000, SUPERMARKET, null]],
  ['#18', '2026-10-06', [500, SUPERMARKET, null]],
  ['#19', '2026-10-12', [-653, 'Entertainment & eat-out / Bubble tea', null, 'Male']],
  ['#20', '2026-10-15', [-6001, 'Personal & medical / Clothing & shoes', null, 'Female']],
  ['#21', '2026-10-22', [-50000, 'Internal transfer', null]],
  ['#22', '2026-10-23', [-2000, 'Uncategorised', null]],
  ['#23', '2026-10-30', [-5002, 'Cash withdrawal', null]],
  ['#24', '2026-11-03', [-14000, SUPERMARKET, null]],
  ['#25', '2026-11-08', [-80000, FURNITURE, true]],
  ['#26', '2026-11-10', [-450, 'Entertainment & eat-out / Bubble tea', null, 'Male']],
  ['#27', '2026-11-12', [-3000, 'Transport & auto / Petrol / EV charging', null]],
];

async function insertScenarioA(): Promise<void> {
  for (const [name, date, split] of SCENARIO_A) {
    await insertTx(name, date, [split], name === '#20' ? 'pending' : 'confirmed');
  }
}

const range = (start: string, end: string) => ({ start, end });

describeDb('M7.7-6 F8 一次性筛选（R22.4，fixtures 12 A-9）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    await insertScenarioA();
  });

  it('R22.4: 2026-06-01 到 2026-11-15，一次性 = 是 → #6 #10 #15 #25，合计 -320000', async () => {
    const r = await list({ period: range('2026-06-01', '2026-11-15'), oneOff: true });
    expect(names(r)).toEqual(['#10', '#15', '#25', '#6']);
    expect(r.totalCents).toBe(-320000);
  });

  it('R22.4: 2026-10，一次性 = 否，类型 = 支出 → #16 #17 #18 #19 #20 #23，合计 -224156', async () => {
    const r = await list({
      period: range('2026-10-01', '2026-10-31'),
      oneOff: false,
      type: 'expense',
    });
    expect(names(r)).toEqual(['#16', '#17', '#18', '#19', '#20', '#23']);
    expect(r.totalCents).toBe(-224156);
  });

  it('R22.4: 2026-10，一次性 = 否 → #16 到 #23 全部（转账、未分类是 null 也算），合计 -276156', async () => {
    const r = await list({ period: range('2026-10-01', '2026-10-31'), oneOff: false });
    expect(names(r)).toEqual(['#16', '#17', '#18', '#19', '#20', '#21', '#22', '#23']);
    expect(r.totalCents).toBe(-276156);
  });

  it('R22.3: 场景 A 里没有大额未标（大额的都标过了，#21 是转账）', async () => {
    expect((await countQuickFilters(t.ctx)).oneOffHint).toBe(0);
    const r = await list({});
    expect(r.items.some((i) => i.oneOffHint)).toBe(false);
  });
});

// ---------- 场景 H（R22.3） ----------

const SCENARIO_H: [string, SplitRow[], ('pending' | 'confirmed')?][] = [
  ['H-1', [[-60000, FURNITURE, null]]],
  ['H-2', [[-50000, FURNITURE, null]]],
  ['H-3', [[-49999, FURNITURE, null]]],
  ['H-4', [[-200000, 'Home & utilities / Rent', false]]],
  [
    'H-5',
    [
      [-30000, SUPERMARKET, null],
      [-50000, FURNITURE, null],
    ],
  ],
  [
    'H-6',
    [
      [-30000, SUPERMARKET, false],
      [-50000, FURNITURE, null],
    ],
  ],
  [
    'H-7',
    [
      [-40000, SUPERMARKET, null],
      [-30000, 'Uncategorised', null],
    ],
  ],
  ['H-8', [[-500000, 'Internal transfer', null]]],
  ['H-9', [[-90000, 'Uncategorised', null]]],
  ['H-10', [[60000, FURNITURE, null]]],
  ['H-11', [[-55000, 'Personal & medical / Clothing & shoes', null]], 'pending'],
  ['H-12', [[-60000, 'Cash withdrawal', null]]],
  ['H-13', [[500000, 'Income / Salary', null]]],
];

const HINTED = ['H-1', 'H-11', 'H-12', 'H-2', 'H-5'];

describeDb('M7.7-6 F8 大额未标（R22.3，fixtures 12 H）', () => {
  const ids = new Map<string, string>();

  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    ids.clear();
    for (const [name, splits, status] of SCENARIO_H) {
      ids.set(name, await insertTx(name, '2026-10-10', splits, status));
    }
  });

  it('R22.3: 快捷筛选"大额未标 5"（H-1、H-2、H-5、H-11、H-12）', async () => {
    expect((await countQuickFilters(t.ctx)).oneOffHint).toBe(5);
    const r = await list({ quick: 'one_off_hint' });
    expect(names(r)).toEqual(HINTED);
    expect(r.count).toBe(5);
    // 合计按整笔交易（M7.7-6 定）
    expect(r.totalCents).toBe(-60000 - 50000 - 80000 - 55000 - 60000);
  });

  it('R22.3: 列表行上的"一次性？"和快捷筛选同一个口径', async () => {
    const r = await list({});
    expect(
      r.items
        .filter((i) => i.oneOffHint)
        .map((i) => i.merchant)
        .sort(),
    ).toEqual(HINTED);
  });

  it('R22.3: 和别的筛选一起用', async () => {
    expect(names(await list({ quick: 'one_off_hint', status: 'pending' }))).toEqual(['H-11']);
  });

  it('R22.3: H-5 点"不是一次性"以后不再提示，"大额未标 4"', async () => {
    expect((await dismissOneOffHint(t.ctx, ids.get('H-5')!, false)).ok).toBe(true);
    expect((await countQuickFilters(t.ctx)).oneOffHint).toBe(4);
    expect(names(await list({ quick: 'one_off_hint' }))).toEqual(HINTED.filter((n) => n !== 'H-5'));
    const r = await list({});
    expect(r.items.find((i) => i.merchant === 'H-5')?.oneOffHint).toBe(false);
  });

  it('R22.3: 别的家庭看不到', async () => {
    const [other] = await db
      .insert(schema.household)
      .values({ name: 'Other Household' })
      .returning({ id: schema.household.id });
    expect(
      (await countQuickFilters({ ...t.ctx, householdId: other.id, memberId: null })).oneOffHint,
    ).toBe(0);
  });
});
