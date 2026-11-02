// M7.7-4 一次性标记的数据层（business-rules.md R22.1、R22.2、R22.3）
// 期望值来自 docs/tasks/m7.7.md M7.7-4 完成标准和 docs/rules/R22-monthly-average.md R22.2 那张表
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { importCsv } from '@/server/imports';
import {
  addSplit,
  dismissOneOffHint,
  removeSplit,
  setSplitOneOff,
  updateSplit,
} from '@/server/splits';
import { updateSplitCategory } from '@/server/transactions';
import { readFixture } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { getSplits } from './helpers/transactions';

let t: DbTestHousehold;

const SUPPLIES = 'Home & utilities / Household supplies';
const COSMETICS = 'Personal & medical / Cosmetics & toiletries';
const INTEREST = 'Income / Interest';

async function importJoint(): Promise<void> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account('ANZ Joint').id,
    fileName: 'anz/joint-2026-09.csv',
    text: readFixture('anz/joint-2026-09.csv'),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
}

// joint #19：2026-09-01 -58.40 COLES 0559 MELBOURNE，支出
async function coles(): Promise<string> {
  const rows = await db
    .select({ id: schema.transaction.id })
    .from(schema.transaction)
    .where(
      and(
        eq(schema.transaction.householdId, t.ctx.householdId),
        eq(schema.transaction.merchant, 'COLES 0559 MELBOURNE'),
      ),
    );
  if (rows.length !== 1) throw new Error(`COLES 有 ${rows.length} 笔`);
  return rows[0].id;
}

async function primaryOf(transactionId: string) {
  return (await getSplits(transactionId)).find((s) => s.isPrimary)!;
}

// 拆分 id → is_one_off
async function flags(transactionId: string): Promise<Record<string, boolean | null>> {
  return Object.fromEntries((await getSplits(transactionId)).map((s) => [s.id, s.isOneOff]));
}

async function addSupplies(transactionId: string, amountCents = 1500): Promise<string> {
  const r = await addSplit(t.ctx, transactionId, {
    amountCents,
    categoryId: t.h.category(SUPPLIES).id,
  });
  if (!r.ok) throw new Error(r.message);
  return r.splitId;
}

describeDb('M7.7-4 一次性标记（R22.1、R22.2、R22.3）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    await importJoint();
  });

  it('R22.2: imported splits start as null', async () => {
    const all = await db
      .select({ isOneOff: schema.transactionSplit.isOneOff })
      .from(schema.transactionSplit)
      .where(eq(schema.transactionSplit.householdId, t.ctx.householdId));
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((s) => s.isOneOff === null)).toBe(true);
  });

  it('R22.1: marking one split changes only that split', async () => {
    const id = await coles();
    const extra = await addSupplies(id);
    const primary = await primaryOf(id);

    expect(await setSplitOneOff(t.ctx, primary.id, true)).toEqual({
      ok: true,
      splitId: primary.id,
    });
    expect(await flags(id)).toEqual({ [primary.id]: true, [extra]: null });

    // 取消勾 = false，回不到 null
    expect((await setSplitOneOff(t.ctx, primary.id, false)).ok).toBe(true);
    expect(await flags(id)).toEqual({ [primary.id]: false, [extra]: null });
  });

  it('R22.2: new split from addSplit defaults to null, or takes the checkbox value', async () => {
    const id = await coles();
    const plain = await addSupplies(id);
    const r = await addSplit(t.ctx, id, {
      amountCents: 800,
      categoryId: t.h.category(COSMETICS).id,
      isOneOff: true,
    });
    if (!r.ok) throw new Error(r.message);
    const f = await flags(id);
    expect(f[plain]).toBeNull();
    expect(f[r.splitId]).toBe(true);
  });

  it('R22.2: non-expense new split ignores the checkbox and stays null', async () => {
    const id = await coles();
    const r = await addSplit(t.ctx, id, {
      amountCents: 800,
      categoryId: t.h.category(INTEREST).id,
      isOneOff: true,
    });
    if (!r.ok) throw new Error(r.message);
    expect((await flags(id))[r.splitId]).toBeNull();
  });

  it('R22.2: primary flag survives add split, change amount, remove split, expense → expense category change', async () => {
    const id = await coles();
    const primary = await primaryOf(id);
    await setSplitOneOff(t.ctx, primary.id, true);

    const extra = await addSupplies(id);
    expect((await flags(id))[primary.id]).toBe(true);

    await setSplitOneOff(t.ctx, extra, false);
    expect((await updateSplit(t.ctx, extra, { amountCents: 2000 })).ok).toBe(true);
    expect(await flags(id)).toEqual({ [primary.id]: true, [extra]: false });

    expect((await removeSplit(t.ctx, extra)).ok).toBe(true);
    expect(await flags(id)).toEqual({ [primary.id]: true });

    // 支出 → 支出：拆分对话框（updateSplit）和 F8 改分类（updateSplitCategory，R16.4）两条路
    const r1 = await updateSplit(t.ctx, primary.id, { categoryId: t.h.category(SUPPLIES).id });
    expect(r1.ok).toBe(true);
    expect((await flags(id))[primary.id]).toBe(true);
    const r2 = await updateSplitCategory(t.ctx, primary.id, t.h.category(COSMETICS).id);
    expect(r2.ok).toBe(true);
    expect((await flags(id))[primary.id]).toBe(true);
  });

  it('R22.2: changing to an income category clears the flag to null (updateSplit and updateSplitCategory)', async () => {
    const id = await coles();
    const primary = await primaryOf(id);
    const extra = await addSupplies(id);
    await setSplitOneOff(t.ctx, primary.id, true);
    await setSplitOneOff(t.ctx, extra, true);

    expect((await updateSplit(t.ctx, extra, { categoryId: t.h.category(INTEREST).id })).ok).toBe(
      true,
    );
    expect(await flags(id)).toEqual({ [primary.id]: true, [extra]: null });

    expect((await updateSplitCategory(t.ctx, primary.id, t.h.category(INTEREST).id)).ok).toBe(true);
    expect(await flags(id)).toEqual({ [primary.id]: null, [extra]: null });
  });

  it('R22.1: non-expense splits cannot be marked', async () => {
    const id = await coles();
    const primary = await primaryOf(id);
    await updateSplitCategory(t.ctx, primary.id, t.h.category(INTEREST).id);

    const r = await setSplitOneOff(t.ctx, primary.id, true);
    expect(r.ok).toBe(false);
    expect((await flags(id))[primary.id]).toBeNull();
  });

  it('R22.3: dismissOneOffHint sets null expense splits to false, leaves marked and non-expense ones', async () => {
    const id = await coles();
    const primary = await primaryOf(id);
    const marked = await addSupplies(id, 1500);
    const income = await addSplit(t.ctx, id, {
      amountCents: 500,
      categoryId: t.h.category(INTEREST).id,
    });
    if (!income.ok) throw new Error(income.message);
    await setSplitOneOff(t.ctx, marked, true);

    expect(await dismissOneOffHint(t.ctx, id)).toEqual({ ok: true });
    expect(await flags(id)).toEqual({
      [primary.id]: false,
      [marked]: true,
      [income.splitId]: null,
    });
  });

  it('R22.3: answering "yes" sets null expense splits to true, leaves marked and non-expense ones', async () => {
    const id = await coles();
    const primary = await primaryOf(id);
    const seen = await addSupplies(id, 1500);
    const fresh = await addSupplies(id, 700);
    const income = await addSplit(t.ctx, id, {
      amountCents: 500,
      categoryId: t.h.category(INTEREST).id,
    });
    if (!income.ok) throw new Error(income.message);
    await setSplitOneOff(t.ctx, seen, false);

    expect(await dismissOneOffHint(t.ctx, id, true)).toEqual({ ok: true });
    expect(await flags(id)).toEqual({
      [primary.id]: true,
      [seen]: false,
      [fresh]: true,
      [income.splitId]: null,
    });
  });

  it('another household cannot mark or dismiss', async () => {
    const id = await coles();
    const primary = await primaryOf(id);

    const [other] = await db
      .insert(schema.household)
      .values({ name: 'Other Household' })
      .returning({ id: schema.household.id });
    const otherCtx = { ...t.ctx, householdId: other.id, memberId: null };

    expect((await setSplitOneOff(otherCtx, primary.id, true)).ok).toBe(false);
    expect((await dismissOneOffHint(otherCtx, id)).ok).toBe(false);
    expect((await flags(id))[primary.id]).toBeNull();
  });

  it('invalid ids are rejected', async () => {
    expect((await setSplitOneOff(t.ctx, 'nope', true)).ok).toBe(false);
    expect((await dismissOneOffHint(t.ctx, 'nope')).ok).toBe(false);
  });
});
