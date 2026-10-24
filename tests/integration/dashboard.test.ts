// M5-2 看板数据层（prd.md F6、business-rules.md R10、R10.1、R10.2）
// 期望值来自 docs/tasks/m5.md M5-2 完成标准和 fixtures/README.md
// "2026 年 9 月统计"、"按周汇总"、"看板"、"期望结果：再导入 me-2026-09.csv"
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { importCsv } from '@/server/imports';
import { getDashboard, getPivot } from '@/server/dashboard';
import type { Summary } from '@/lib/rules/stats';
import type { HouseholdContext } from '@/server/context';
import { readFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

const TODAY = '2026-10-24';
const SEPT = { start: '2026-09-01', end: '2026-09-30' };

let t: DbTestHousehold;

async function importFixture(
  into: DbTestHousehold,
  account: string,
  path: FixturePath,
): Promise<void> {
  const result = await importCsv(into.ctx, {
    accountId: into.h.account(account).id,
    fileName: path,
    text: readFixture(path),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
}

const cat = (path: string) => t.h.category(path);
const mem = (name: string) => t.h.member(name).id;

function expenseOf(s: Summary, path: string): number | undefined {
  const c = cat(path);
  if (!c.parentId) return s.expenseByCategory.find((x) => x.categoryId === c.id)?.cents;
  const top = s.expenseByCategory.find((x) => x.categoryId === c.parentId);
  return top?.children.find((x) => x.categoryId === c.id)?.cents;
}

function memberExpense(s: Summary, name: string): number {
  return s.byMember.find((m) => m.memberId === mem(name))?.expenseCents ?? 0;
}

describeDb('M5-2 getDashboard / getPivot', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('joint only, Sept 2026: totals, categories and members match fixtures (R10)', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const d = await getDashboard(t.ctx, { period: SEPT }, TODAY);
    const s = d.current;

    expect(d.period).toEqual({ option: 'custom', ...SEPT });
    expect(s.expenseCents).toBe(45575);
    expect(s.incomeCents).toBe(0);
    expect(s.savingsRate).toBeNull();
    expect(s.uncategorized.count).toBe(4);
    expect(expenseOf(s, 'Groceries / Supermarket')).toBe(15795);
    expect(expenseOf(s, 'Personal & medical / Other')).toBe(-4580);
    expect(expenseOf(s, 'Bank fees')).toBe(0);
    expect(memberExpense(s, 'Male')).toBe(900);
    expect(memberExpense(s, 'Female')).toBe(0);
    expect(memberExpense(s, 'Home')).toBe(44675);
  });

  it('joint only, Sept 2026: board blocks (R10.3 to R10.6)', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const d = await getDashboard(t.ctx, { period: SEPT }, TODAY);

    expect(d.topMerchants[0]).toEqual({
      merchant: 'GONG CHA & HO/SPENCER ST MELBOURNE',
      count: 2,
      cents: 900,
    });
    expect(d.topMerchants).toHaveLength(5);
    expect(d.comparison).toEqual({
      incomePercent: null,
      expensePercent: null,
      savingsRatePoints: null,
    });
    expect(d.pendingCount).toBe(0);

    expect(d.trend).toHaveLength(12);
    expect(d.trend[0].start).toBe('2025-11-01');
    expect(d.trend[11]).toMatchObject({
      start: '2026-10-01',
      end: '2026-10-24',
    });
    expect(d.trend[10]).toMatchObject({
      incomeCents: 0,
      expenseCents: 45575,
      netCents: -45575,
    });
  });

  it('R10.6: Male filter → expense 900, top merchant only GONG CHA', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const d = await getDashboard(t.ctx, { period: SEPT, memberId: mem('Male') }, TODAY);
    expect(d.current.expenseCents).toBe(900);
    expect(d.topMerchants).toEqual([
      { merchant: 'GONG CHA & HO/SPENCER ST MELBOURNE', count: 2, cents: 900 },
    ]);
  });

  it('R10.2: joint only, Sept by week matches the table (two partial weeks, negative 9/14 week)', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const { pivot } = await getPivot(
      t.ctx,
      {
        period: SEPT,
        granularity: 'week',
        groupBy: 'category',
        metric: 'expense',
      },
      TODAY,
    );

    expect(pivot.columns).toEqual([
      { start: '2026-09-01', end: '2026-09-06', partial: true },
      { start: '2026-09-07', end: '2026-09-13', partial: false },
      { start: '2026-09-14', end: '2026-09-20', partial: false },
      { start: '2026-09-21', end: '2026-09-27', partial: false },
      { start: '2026-09-28', end: '2026-09-30', partial: true },
    ]);
    expect(pivot.columnTotals).toEqual([5840, 8580, -705, 21120, 10740]);
    expect(pivot.total).toBe(45575);
  });

  it('R10.6: pivot grouped by member with Male filter → one row', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const { pivot } = await getPivot(
      t.ctx,
      {
        period: SEPT,
        memberId: mem('Male'),
        granularity: 'week',
        groupBy: 'member',
        metric: 'expense',
      },
      TODAY,
    );
    expect(pivot.rows.map((r) => r.key)).toEqual([mem('Male')]);
    expect(pivot.columnTotals).toEqual([0, 0, 0, 0, 900]);
  });

  it('R10.1: today 2026-10-15, this financial year starts 2026-07-01', async () => {
    const d = await getDashboard(t.ctx, { period: 'this_fy' }, '2026-10-15');
    expect(d.period).toEqual({
      option: 'this_fy',
      start: '2026-07-01',
      end: '2026-10-15',
    });
    const p = await getPivot(
      t.ctx,
      {
        period: 'this_fy',
        granularity: 'month',
        groupBy: 'category',
        metric: 'expense',
      },
      '2026-10-15',
    );
    expect(p.period.start).toBe('2026-07-01');
    expect(p.pivot.columns[0]).toEqual({
      start: '2026-07-01',
      end: '2026-07-31',
      partial: false,
    });
  });

  it('R10/R6: joint + me → auto transfers on both sides are not income or expense', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture(t, 'ANZ Male', 'anz/me-2026-09.csv');
    const s = (await getDashboard(t.ctx, { period: SEPT }, TODAY)).current;

    // Joint #17 +2000.00 和 me 的 TO ****0001 -2000.00 都是 auto：不在收入也不在支出
    // 收入只有 me 的 SALARY 5200.00
    expect(s.incomeCents).toBe(520000);
    // 支出 = joint 的 45575 + me 的 MYKI -30.00（Transport & auto / Public transport）
    // 转账没有把支出算多（docs/tasks/m5.md M5-2）
    expect(s.expenseCents).toBe(45575 + 3000);
    // Joint #7 和 PAYID PAYMENT 是 suggested，仍按未分类算
    expect(s.uncategorized.count).toBe(5);
  });

  it("another household cannot see this household's data", async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');

    // household_user.user_id 唯一，测试用户只能属于一个家庭，所以另一个家庭直接插一条（同 transactions.test.ts）
    const [other] = await db
      .insert(schema.household)
      .values({ name: 'Other Household' })
      .returning({ id: schema.household.id });
    const otherCtx: HouseholdContext = { ...t.ctx, householdId: other.id, memberId: null };

    const d = await getDashboard(otherCtx, { period: SEPT }, TODAY);
    expect(d.current.expenseCents).toBe(0);
    expect(d.current.uncategorized.count).toBe(0);
    expect(d.topMerchants).toEqual([]);
    expect(d.trend.every((m) => m.incomeCents === 0 && m.expenseCents === 0)).toBe(true);

    const { pivot } = await getPivot(
      otherCtx,
      { period: SEPT, granularity: 'week', groupBy: 'category', metric: 'expense' },
      TODAY,
    );
    expect(pivot.rows).toEqual([]);
    expect(pivot.total).toBe(0);

    // 对照：本家庭自己能查到
    expect((await getDashboard(t.ctx, { period: SEPT }, TODAY)).current.expenseCents).toBe(45575);
  });
});
