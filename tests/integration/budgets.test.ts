// M7-2 预算的数据层（business-rules.md R11.1、R11.2、R11.3、R19.4）
// 期望值来自 docs/tasks/m7.md M7-2 完成标准和 R11.1 场景 1
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import {
  createBudget,
  deleteBudget,
  listBudgetsWithProgress,
  setBudgetPinned,
  updateBudget,
} from '@/server/budgets';
import { archiveCategory, listCategoriesForAdmin } from '@/server/categories';
import { importCsv } from '@/server/imports';
import { readFixture } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

let t: DbTestHousehold;

const TODAY = '2026-09-30';
const ENT = 'Entertainment & eat-out';
const BUBBLE_TEA = 'Entertainment & eat-out / Bubble tea';

const cat = (path: string) => t.h.category(path).id;
const cash = () => t.h.systemCategory('cash_withdrawal').id;

async function importJoint(): Promise<void> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account('ANZ Joint').id,
    fileName: 'anz/joint-2026-09.csv',
    text: readFixture('anz/joint-2026-09.csv'),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
}

async function create(categoryId: string, monthlyLimit: string, extra = {}) {
  const r = await createBudget(t.ctx, { categoryId, monthlyLimit, ...extra });
  if (!r.ok) throw new Error(`建预算失败: ${r.message}`);
  return r.budgetId;
}

// R11.1 场景 1 的四个预算
async function scenario1() {
  return {
    groceries: await create(cat('Groceries'), '200.00'),
    ent: await create(cat(ENT), '100.00'),
    bubbleTea: await create(cat(BUBBLE_TEA), '5.00'),
    cash: await create(cash(), '100.00'),
  };
}

async function budgetRows() {
  return db
    .select()
    .from(schema.budget)
    .where(eq(schema.budget.householdId, t.ctx.householdId))
    .orderBy(schema.budget.id);
}

// 另一个家庭：一个支出一级
async function otherHouseholdCategory() {
  const [hh] = await db
    .insert(schema.household)
    .values({ name: 'Other Household' })
    .returning({ id: schema.household.id });
  const [top] = await db
    .insert(schema.category)
    .values({ householdId: hh.id, nameEn: 'Other top', kind: 'expense', sortOrder: 0 })
    .returning({ id: schema.category.id });
  return { householdId: hh.id, categoryId: top.id };
}

async function deleteRulesFor(categoryIds: string[]) {
  await db
    .delete(schema.categoryRule)
    .where(
      and(
        eq(schema.categoryRule.householdId, t.ctx.householdId),
        inArray(schema.categoryRule.categoryId, categoryIds),
      ),
    );
}

describeDb('M7-2 budgets data layer', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  // ---------- 新建 ----------

  it('R11.2: create Groceries budget → row with cents, default warn 80, not pinned', async () => {
    const id = await create(cat('Groceries'), '200.00');
    const rows = await budgetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      householdId: t.ctx.householdId,
      categoryId: cat('Groceries'),
      monthlyLimitCents: 20000,
      warnAtPercent: 80,
      isPinned: false,
    });
  });

  it('category from another household cannot get a budget, nothing is written', async () => {
    const other = await otherHouseholdCategory();
    expect(
      await createBudget(t.ctx, { categoryId: other.categoryId, monthlyLimit: '100.00' }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await db.select().from(schema.budget)).toEqual([]);
  });

  it('R11.2: income, bank fees, internal transfer, uncategorized cannot have a budget', async () => {
    const income = t.h.categories.find((c) => c.kind === 'income' && c.parentId === null)!;
    for (const id of [
      income.id,
      t.h.systemCategory('bank_fee').id,
      t.h.systemCategory('internal_transfer').id,
      t.h.systemCategory('uncategorized').id,
    ]) {
      expect(await createBudget(t.ctx, { categoryId: id, monthlyLimit: '100.00' })).toMatchObject({
        ok: false,
        reason: 'invalid',
        message: '这个分类不能设预算',
      });
    }
    expect(await budgetRows()).toEqual([]);
  });

  it('R11.2: archived category cannot have a budget', async () => {
    await db
      .update(schema.category)
      .set({ isArchived: true })
      .where(eq(schema.category.id, cat(BUBBLE_TEA)));
    expect(
      await createBudget(t.ctx, { categoryId: cat(BUBBLE_TEA), monthlyLimit: '5.00' }),
    ).toMatchObject({ ok: false, reason: 'invalid', message: '这个分类不能设预算' });
  });

  it('R11.2: second budget for the same category → "这个分类已经有预算"', async () => {
    await create(cat('Groceries'), '200.00');
    expect(
      await createBudget(t.ctx, { categoryId: cat('Groceries'), monthlyLimit: '300.00' }),
    ).toEqual({ ok: false, reason: 'invalid', message: '这个分类已经有预算' });
    expect(await budgetRows()).toHaveLength(1);
  });

  it('limit must be > 0, warn percent an integer 1–100', async () => {
    const bad = [
      { monthlyLimit: '0' },
      { monthlyLimit: '-5.00' },
      { monthlyLimit: 'abc' },
      { monthlyLimit: '5.00', warnAtPercent: 0 },
      { monthlyLimit: '5.00', warnAtPercent: 101 },
      { monthlyLimit: '5.00', warnAtPercent: 50.5 },
    ];
    for (const input of bad) {
      expect(
        await createBudget(t.ctx, { categoryId: cat('Groceries'), ...input }),
      ).toMatchObject({ ok: false, reason: 'invalid' });
    }
    expect(await budgetRows()).toEqual([]);
  });

  // ---------- 修改、固定、删除 ----------

  it('update changes limit, warn percent and pinned, not the category', async () => {
    const id = await create(cat('Groceries'), '200.00');
    expect(
      await updateBudget(t.ctx, id, {
        monthlyLimit: '250.50',
        warnAtPercent: 90,
        isPinned: true,
        // 表单被改过也不能换分类
        categoryId: cat(ENT),
      } as Parameters<typeof updateBudget>[2]),
    ).toEqual({ ok: true, budgetId: id });
    const [row] = await budgetRows();
    expect(row).toMatchObject({
      categoryId: cat('Groceries'),
      monthlyLimitCents: 25050,
      warnAtPercent: 90,
      isPinned: true,
    });
  });

  it('setBudgetPinned toggles is_pinned', async () => {
    const id = await create(cat('Groceries'), '200.00');
    expect(await setBudgetPinned(t.ctx, id, true)).toEqual({ ok: true, budgetId: id });
    expect((await budgetRows())[0].isPinned).toBe(true);
    expect(await setBudgetPinned(t.ctx, id, false)).toEqual({ ok: true, budgetId: id });
    expect((await budgetRows())[0].isPinned).toBe(false);
  });

  it('R11.3: delete is a hard delete', async () => {
    const id = await create(cat('Groceries'), '200.00');
    expect(await deleteBudget(t.ctx, id)).toEqual({ ok: true, budgetId: id });
    expect(await budgetRows()).toEqual([]);
    expect(await deleteBudget(t.ctx, id)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('another household’s budget: update, pin and delete return not_found and change nothing', async () => {
    const other = await otherHouseholdCategory();
    const [b] = await db
      .insert(schema.budget)
      .values({ householdId: other.householdId, categoryId: other.categoryId, monthlyLimitCents: 100 })
      .returning();
    const notFound = { ok: false, reason: 'not_found' };
    expect(await updateBudget(t.ctx, b.id, { monthlyLimit: '9.00' })).toMatchObject(notFound);
    expect(await setBudgetPinned(t.ctx, b.id, true)).toMatchObject(notFound);
    expect(await deleteBudget(t.ctx, b.id)).toMatchObject(notFound);
    expect(await updateBudget(t.ctx, 'nope', { monthlyLimit: '9.00' })).toMatchObject(notFound);
    const [after] = await db.select().from(schema.budget).where(eq(schema.budget.id, b.id));
    expect(after).toEqual(b);
    expect((await listBudgetsWithProgress(t.ctx, TODAY)).budgets).toEqual([]);
  });

  // ---------- listBudgetsWithProgress ----------

  it('R11.1 scenario 1: totals 40000 / 37815 / 2185, Bubble tea included in Entertainment', async () => {
    await importJoint();
    const ids = await scenario1();

    const { budgets, overview } = await listBudgetsWithProgress(t.ctx, TODAY);
    expect(overview.limitCents).toBe(40000);
    expect(overview.spentCents).toBe(37815);
    expect(overview.remainingCents).toBe(2185);
    expect(overview.uncovered.map((u) => [u.label, u.cents])).toEqual([
      ['Home & utilities', 9840],
      ['Transport & auto', 2500],
      ['Personal & medical', -4580],
    ]);

    // 一级按 sort_order，二级跟在它的一级后面，现金支出排最后
    expect(budgets.map((b) => b.id)).toEqual([ids.groceries, ids.ent, ids.bubbleTea, ids.cash]);
    const bubble = budgets.find((b) => b.id === ids.bubbleTea)!;
    expect(bubble).toMatchObject({
      label: BUBBLE_TEA,
      parentId: cat(ENT),
      includedIn: cat(ENT),
      monthlyLimitCents: 500,
      progress: { spentCents: 900, limitCents: 500, level: 'over' },
    });
    expect(budgets.find((b) => b.id === ids.cash)).toMatchObject({
      includedIn: null,
      progress: { spentCents: 15000, level: 'over' },
    });
    expect(budgets.find((b) => b.id === ids.ent)?.includedIn).toBeNull();
  });

  it('no budgets: empty list, totals 0', async () => {
    await importJoint();
    const { budgets, overview } = await listBudgetsWithProgress(t.ctx, TODAY);
    expect(budgets).toEqual([]);
    expect(overview).toMatchObject({ limitCents: 0, spentCents: 0, remainingCents: 0 });
  });

  // ---------- R19.4 归档时一起删 ----------

  it('R19.4: admin list carries budget counts, top includes its children', async () => {
    await scenario1();
    const list = await listCategoriesForAdmin(t.ctx);
    const ent = list.expense.find((c) => c.id === cat(ENT))!;
    expect(ent.budgetCount).toBe(2);
    expect(ent.children.find((c) => c.id === cat(BUBBLE_TEA))?.budgetCount).toBe(1);
    expect(list.expense.find((c) => c.id === cat('Groceries'))?.budgetCount).toBe(1);
    expect(list.system.find((c) => c.id === cash())?.budgetCount).toBe(1);
  });

  it('R19.4: archive Entertainment & eat-out → its and Bubble tea’s budgets deleted, others kept', async () => {
    const ids = await scenario1();
    const entChildren = t.h.categories.filter((c) => c.parentId === cat(ENT)).map((c) => c.id);
    await deleteRulesFor([cat(ENT), ...entChildren]);

    const r = await archiveCategory(t.ctx, cat(ENT));
    expect(r).toMatchObject({ ok: true, deletedBudgetCount: 2 });
    expect((await budgetRows()).map((b) => b.id).sort()).toEqual([ids.groceries, ids.cash].sort());
  });

  it('R19.4: rules still block archiving, budgets are kept', async () => {
    await scenario1();
    expect(await archiveCategory(t.ctx, cat(ENT))).toMatchObject({
      ok: false,
      reason: 'has_rules',
    });
    expect(await budgetRows()).toHaveLength(4);
    expect((await db.select().from(schema.category).where(eq(schema.category.id, cat(ENT))))[0])
      .toMatchObject({ isArchived: false });
  });
});
