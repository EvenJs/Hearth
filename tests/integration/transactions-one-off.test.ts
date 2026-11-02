// M7.7-6 F8 一次性筛选和大额未标（business-rules.md R22.3、R22.4、R16.5）
// 期望值来自 fixtures/cases/12-monthly-average.md 场景 A（A-9）和 H
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { TransactionFilters } from '@/lib/transactions/filters';
import { dismissOneOffHint } from '@/server/splits';
import { countQuickFilters, listTransactions } from '@/server/transactions';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import {
  FURNITURE,
  insertScenarioA,
  insertTx,
  SUPERMARKET,
  type SplitRow,
} from './helpers/one-off';

// fixtures/cases/12：今天 = 2026-11-15
const TODAY = '2026-11-15';

let t: DbTestHousehold;

const list = (filters: TransactionFilters) =>
  listTransactions(t.ctx, filters, { today: TODAY, pageSize: 200 });

const names = (r: Awaited<ReturnType<typeof list>>) => r.items.map((i) => i.merchant).sort();

// ---------- 场景 A（A-9） ----------

const range = (start: string, end: string) => ({ start, end });

describeDb('M7.7-6 F8 一次性筛选（R22.4，fixtures 12 A-9）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    await insertScenarioA(t);
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
      ids.set(name, await insertTx(t, name, '2026-10-10', splits, status));
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
