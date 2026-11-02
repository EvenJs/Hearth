// M7.7-7 看板月均卡片和"其中一次性"的数据层（business-rules.md R22.5 到 R22.10）
// 期望值来自 fixtures/cases/12-monthly-average.md 场景 A（A-2 到 A-8）
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getDashboard } from '@/server/dashboard';
import { getMonthlyAverage, type AverageRow } from '@/server/monthly-average';
import { setSplitOneOff } from '@/server/splits';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { insertScenarioA } from './helpers/one-off';
import { getSplits } from './helpers/transactions';

// fixtures/cases/12：今天 = 2026-11-15
const TODAY = '2026-11-15';

let t: DbTestHousehold;
let ids: Map<string, string>;

const cat = (path: string) => t.h.category(path).id;
const mem = (name: string) => t.h.member(name).id;

async function card(memberId?: string) {
  const c = await getMonthlyAverage(t.ctx, TODAY, memberId);
  if (!c) throw new Error('没有完整月');
  return c;
}

function row(rows: AverageRow[], key: string): AverageRow {
  const r = rows.find((x) => x.key === key);
  if (!r) throw new Error(`没有这一行: ${key}`);
  return r;
}

function child(rows: AverageRow[], path: string) {
  const id = cat(path);
  const c = rows.flatMap((r) => r.children).find((x) => x.categoryId === id && !x.unsplit);
  if (!c) throw new Error(`没有这个二级: ${path}`);
  return c;
}

describeDb('M7.7-7 getMonthlyAverage（R22.5 到 R22.9，fixtures 12 场景 A）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    ids = await insertScenarioA(t);
  });

  it('R22.5: 没有交易 → null（"还没有完整月的数据"）', async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    expect(await getMonthlyAverage(t.ctx, TODAY)).toBeNull();
  });

  it('R22.5: 最早一笔在本月 → null', async () => {
    expect(await getMonthlyAverage(t.ctx, '2026-06-30')).toBeNull();
  });

  it('A-2: 近 12 个月基于 5 个月，总月均 212855，一级按月均排序', async () => {
    const c = await card();
    expect(c.months12).toBe(5);
    expect(c.total.avg12Cents).toBe(212855);
    expect(c.byCategory.map((r) => [r.key, r.avg12Cents])).toEqual([
      [cat('Home & utilities'), 200000],
      [cat('Groceries'), 11260],
      [cat('Cash withdrawal'), 1000],
      [cat('Entertainment & eat-out'), 311],
      [cat('Personal & medical'), 284],
      // R22.8：本月才有，12 个月月均 0 也列
      [cat('Transport & auto'), 0],
    ]);
  });

  it('A-3: 二级在一级里再分，负数照实显示；只有一次性的二级不列', async () => {
    const c = await card();
    expect(child(c.byCategory, 'Groceries / Supermarket').avg12Cents).toBe(11000);
    expect(child(c.byCategory, 'Groceries / Fruit').avg12Cents).toBe(260);
    expect(child(c.byCategory, 'Personal & medical / Clothing & shoes').avg12Cents).toBe(1200);
    expect(child(c.byCategory, 'Personal & medical / Other').avg12Cents).toBe(-916);
    expect(child(c.byCategory, 'Home & utilities / Rent').avg12Cents).toBe(200000);
    expect(child(c.byCategory, 'Entertainment & eat-out / Bubble tea').avg12Cents).toBe(311);
    const childIds = c.byCategory.flatMap((r) => r.children.map((x) => x.categoryId));
    expect(childIds).not.toContain(cat('Entertainment & eat-out / Holidays'));
    // #25 本月一次性也不算本月，Furniture 两个窗口和本月都是 0
    expect(childIds).not.toContain(cat('Home & utilities / Furniture & appliances'));
  });

  it('A-4: 近 12 个月按归属人', async () => {
    const c = await card();
    expect(c.byMember.map((r) => [r.key, r.avg12Cents])).toEqual([
      [mem('Home'), 212261],
      [mem('Male'), 310],
      [mem('Female'), 284],
    ]);
  });

  it('A-5: 近 3 个月基于 3 个月，总月均 214093', async () => {
    const c = await card();
    expect(c.months3).toBe(3);
    expect(c.total.avg3Cents).toBe(214093);
    expect(row(c.byCategory, cat('Home & utilities')).avg3Cents).toBe(200000);
    expect(row(c.byCategory, cat('Groceries')).avg3Cents).toBe(11434);
    expect(row(c.byCategory, cat('Cash withdrawal')).avg3Cents).toBe(1667);
    expect(row(c.byCategory, cat('Entertainment & eat-out')).avg3Cents).toBe(518);
    expect(row(c.byCategory, cat('Personal & medical')).avg3Cents).toBe(474);
    expect(child(c.byCategory, 'Groceries / Supermarket').avg3Cents).toBe(11000);
    expect(child(c.byCategory, 'Groceries / Fruit').avg3Cents).toBe(434);
    expect(child(c.byCategory, 'Personal & medical / Clothing & shoes').avg3Cents).toBe(2001);
    expect(child(c.byCategory, 'Personal & medical / Other').avg3Cents).toBe(-1527);
    expect(row(c.byMember, mem('Home')).avg3Cents).toBe(213102);
    expect(row(c.byMember, mem('Male')).avg3Cents).toBe(518);
    expect(row(c.byMember, mem('Female')).avg3Cents).toBe(473);
  });

  it('A-6: 选了 Male → 只算 Male 的拆分', async () => {
    const c = await card(mem('Male'));
    expect(c.total.avg12Cents).toBe(311);
    expect(c.total.avg3Cents).toBe(518);
    expect(c.byCategory.map((r) => [r.key, r.avg12Cents])).toEqual([
      [cat('Entertainment & eat-out'), 311],
    ]);
    expect(c.byMember.map((r) => [r.key, r.avg12Cents])).toEqual([[mem('Male'), 311]]);
  });

  it('A-7: 本月排除一次性，对比近 12 个月月均', async () => {
    const c = await card();
    expect(c.total.currentCents).toBe(17450);
    expect(c.total.percent).toBe(-92);
    const pct = (path: string) => row(c.byCategory, cat(path));
    expect(pct('Home & utilities')).toMatchObject({ currentCents: 0, percent: -100 });
    expect(pct('Groceries')).toMatchObject({ currentCents: 14000, percent: 24 });
    expect(pct('Cash withdrawal')).toMatchObject({ currentCents: 0, percent: -100 });
    expect(pct('Entertainment & eat-out')).toMatchObject({ currentCents: 450, percent: 45 });
    expect(pct('Personal & medical')).toMatchObject({ currentCents: 0, percent: -100 });
    expect(pct('Transport & auto')).toMatchObject({ currentCents: 3000, percent: null });
    expect(child(c.byCategory, 'Personal & medical / Other').percent).toBeNull();
    expect(row(c.byMember, mem('Home'))).toMatchObject({ currentCents: 17000, percent: -92 });
    expect(row(c.byMember, mem('Male'))).toMatchObject({ currentCents: 450, percent: 45 });
    expect(row(c.byMember, mem('Female'))).toMatchObject({ currentCents: 0, percent: -100 });
  });

  it('R22.6: 窗口里标一笔一次性 → 月均少了', async () => {
    // #17 2026-10-05 -13000 Supermarket
    const [split] = await getSplits(ids.get('#17')!);
    const r = await setSplitOneOff(t.ctx, split.id, true);
    expect(r.ok).toBe(true);
    const c = await card();
    // (1064277 − 13000) ÷ 5 = 210255.4 → 210255
    expect(c.total.avg12Cents).toBe(210255);
  });

  it('R22.6: 归档分类的支出照算，标"已归档"', async () => {
    const fruit = cat('Groceries / Fruit');
    // Fruit 有预置规则，archiveCategory 不让归档（R19.4）。这里只测月均，直接改库
    await db.update(schema.category).set({ isArchived: true }).where(eq(schema.category.id, fruit));
    const c = await card();
    expect(child(c.byCategory, 'Groceries / Fruit').avg12Cents).toBe(260);
    expect(c.categories[fruit].isArchived).toBe(true);
    expect(c.categories[cat('Groceries')].isArchived).toBe(false);
  });
});

describeDb('M7.7-7 getDashboard 其中一次性（R22.10，fixtures 12 A-8）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    ids = await insertScenarioA(t);
  });

  const dashboard = (period: Parameters<typeof getDashboard>[1]['period'], memberId?: string) =>
    getDashboard(t.ctx, { period, memberId }, TODAY);
  const range = (start: string, end: string) => ({ start, end });

  it('A-8: 本月全部 → 支出 97450，其中一次性 80000', async () => {
    const d = await dashboard('this_month');
    expect(d.current.expenseCents).toBe(97450);
    expect(d.oneOffExpenseCents).toBe(80000);
  });

  it('A-8: 本月 Male → 支出 450，其中一次性 0', async () => {
    const d = await dashboard('this_month', mem('Male'));
    expect(d.current.expenseCents).toBe(450);
    expect(d.oneOffExpenseCents).toBe(0);
  });

  it('A-8: 2026-07 到 2026-08 → 支出 542803，其中一次性 120000', async () => {
    const d = await dashboard(range('2026-07-01', '2026-08-31'));
    expect(d.current.expenseCents).toBe(542803);
    expect(d.oneOffExpenseCents).toBe(120000);
  });

  it('A-8: 2026-08 → 支出 180803，其中一次性 -30000（只有退款）', async () => {
    const d = await dashboard(range('2026-08-01', '2026-08-31'));
    expect(d.current.expenseCents).toBe(180803);
    expect(d.oneOffExpenseCents).toBe(-30000);
  });

  it('A-8: 2026-10 → 支出 224156，其中一次性 0', async () => {
    const d = await dashboard(range('2026-10-01', '2026-10-31'));
    expect(d.current.expenseCents).toBe(224156);
    expect(d.oneOffExpenseCents).toBe(0);
  });

  it('A-8: 本财年 → 其中一次性 320000', async () => {
    const d = await dashboard('this_fy');
    expect(d.oneOffExpenseCents).toBe(320000);
  });

  it('R22.10: 标一笔一次性 → 本期支出不变，其中一次性多了', async () => {
    const before = await dashboard('this_month');
    const [split] = await getSplits(ids.get('#24')!);
    expect((await setSplitOneOff(t.ctx, split.id, true)).ok).toBe(true);
    const after = await dashboard('this_month');
    expect(after.current.expenseCents).toBe(before.current.expenseCents);
    expect(after.oneOffExpenseCents).toBe(80000 + 14000);
  });
});
