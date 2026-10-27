// M6.5-6 设置 → 分类的数据层（business-rules.md R16.3、R19）
// 期望值来自 docs/tasks/m6.5.md M6.5-6 完成标准
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import {
  archiveCategory,
  createCategory,
  listCategoriesForAdmin,
  listCategoryTree,
  unarchiveCategory,
  updateCategory,
} from '@/server/categories';
import { getDashboard, getPivot } from '@/server/dashboard';
import { importCsv } from '@/server/imports';
import { readFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

let t: DbTestHousehold;

const TODAY = '2026-10-24';
const SEPT = { start: '2026-09-01', end: '2026-09-30' };
const ENT = 'Entertainment & eat-out';
const COFFEE = 'Entertainment & eat-out / Coffee & tea';

const cat = (path: string) => t.h.category(path).id;

async function importFixture(account: string, path: FixturePath): Promise<void> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account(account).id,
    fileName: path,
    text: readFixture(path),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
}

// 本家庭的分类行，按 id 排
async function categoryRows() {
  return db
    .select()
    .from(schema.category)
    .where(eq(schema.category.householdId, t.ctx.householdId))
    .orderBy(schema.category.id);
}

async function categoryRow(id: string) {
  const [row] = await db.select().from(schema.category).where(eq(schema.category.id, id));
  return row;
}

async function childrenOf(parentId: string) {
  return db
    .select()
    .from(schema.category)
    .where(eq(schema.category.parentId, parentId))
    .orderBy(schema.category.sortOrder);
}

// 本家庭所有拆分的分类和归属人
async function splitRows() {
  return db
    .select({
      id: schema.transactionSplit.id,
      categoryId: schema.transactionSplit.categoryId,
      memberId: schema.transactionSplit.memberId,
      memberSource: schema.transactionSplit.memberSource,
    })
    .from(schema.transactionSplit)
    .where(eq(schema.transactionSplit.householdId, t.ctx.householdId))
    .orderBy(schema.transactionSplit.id);
}

// 删掉指向这些分类的规则
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

const rulesPointingAt = (categoryIds: string[]) =>
  t.h.rules.filter((r) => categoryIds.includes(r.categoryId)).length;

// 另一个家庭：一个一级、一个 Other 二级、一个归属人
async function otherHousehold() {
  const [hh] = await db
    .insert(schema.household)
    .values({ name: 'Other Household' })
    .returning({ id: schema.household.id });
  const [m] = await db
    .insert(schema.member)
    .values({ householdId: hh.id, name: 'Someone', kind: 'person' })
    .returning({ id: schema.member.id });
  const [top] = await db
    .insert(schema.category)
    .values({ householdId: hh.id, nameEn: 'Other top', kind: 'expense', sortOrder: 0 })
    .returning({ id: schema.category.id });
  const [child] = await db
    .insert(schema.category)
    .values({
      householdId: hh.id,
      parentId: top.id,
      nameEn: 'Other',
      kind: 'expense',
      isOther: true,
      sortOrder: 0,
    })
    .returning({ id: schema.category.id });
  return { householdId: hh.id, memberId: m.id, topId: top.id, childId: child.id };
}

describeDb('M6.5-6 listCategoriesForAdmin / createCategory / updateCategory / archive', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  // ---------- R19.2 新建 ----------

  it('R19.2: create expense top Kids → Kids and Kids / Other in the db, Kids last among expense tops', async () => {
    const r = await createCategory(t.ctx, { nameEn: '  Kids ', parentId: null, kind: 'expense' });
    expect(r.ok).toBe(true);
    const kidsId = r.ok ? r.categoryId : '';

    const kids = await categoryRow(kidsId);
    expect(kids).toMatchObject({
      householdId: t.ctx.householdId,
      parentId: null,
      nameEn: 'Kids',
      kind: 'expense',
      isOther: false,
      isArchived: false,
    });
    const children = await childrenOf(kidsId);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      householdId: t.ctx.householdId,
      nameEn: 'Other',
      kind: 'expense',
      isOther: true,
      defaultMemberId: null,
    });

    const list = await listCategoriesForAdmin(t.ctx);
    expect(list.expense.at(-1)?.id).toBe(kidsId);
    expect(list.expense.at(-1)?.children.map((c) => c.nameEn)).toEqual(['Other']);
  });

  it('R19.2: create Gaming under Entertainment & eat-out → before Other, Other still last', async () => {
    const r = await createCategory(t.ctx, { nameEn: 'Gaming', parentId: cat(ENT) });
    expect(r.ok).toBe(true);
    const names = (await childrenOf(cat(ENT))).map((c) => c.nameEn);
    expect(names.at(-2)).toBe('Gaming');
    expect(names.at(-1)).toBe('Other');
  });

  it('R19.2: duplicate name (case-insensitive) is an error and nothing is written', async () => {
    const before = await categoryRows();
    expect(
      await createCategory(t.ctx, { nameEn: ' coffee  & TEA ', parentId: cat(ENT) }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await categoryRows()).toEqual(before);
  });

  it('R19.2: default member from another household is rejected, nothing is written', async () => {
    const other = await otherHousehold();
    const before = await categoryRows();
    expect(
      await createCategory(t.ctx, {
        nameEn: 'Kids',
        parentId: null,
        kind: 'expense',
        defaultMemberId: other.memberId,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await categoryRows()).toEqual(before);
  });

  it('R19.2: cannot create under another household’s top', async () => {
    const other = await otherHousehold();
    expect(await createCategory(t.ctx, { nameEn: 'Sneaky', parentId: other.topId })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await childrenOf(other.topId)).toHaveLength(1);
  });

  // ---------- R19.3 修改 ----------

  it('R19.3: change Groceries default member → category changes, existing splits keep their member', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const before = await splitRows();

    expect(
      await updateCategory(t.ctx, cat('Groceries'), { defaultMemberId: t.h.member('Male').id }),
    ).toEqual({ ok: true, categoryId: cat('Groceries') });

    expect((await categoryRow(cat('Groceries'))).defaultMemberId).toBe(t.h.member('Male').id);
    expect(await splitRows()).toEqual(before);
  });

  it('R19.3: rename is normalised; Other rename and changing kind are rejected', async () => {
    expect(await updateCategory(t.ctx, cat(COFFEE), { nameEn: '  Coffee  ' })).toMatchObject({
      ok: true,
    });
    expect((await categoryRow(cat(COFFEE))).nameEn).toBe('Coffee');

    expect(await updateCategory(t.ctx, cat(`${ENT} / Other`), { nameEn: 'Misc' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await updateCategory(t.ctx, cat(COFFEE), { kind: 'income' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('R19.3: system category cannot be changed', async () => {
    const id = t.h.systemCategory('uncategorized').id;
    const before = await categoryRow(id);
    expect(await updateCategory(t.ctx, id, { nameEn: 'Unsorted' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await categoryRow(id)).toEqual(before);
  });

  // ---------- R19.4 归档 ----------

  it('R19.4: rules pointing at Coffee & tea block archiving, nothing changes', async () => {
    const n = rulesPointingAt([cat(COFFEE)]);
    expect(n).toBeGreaterThan(0);
    const before = await categoryRows();

    expect(await archiveCategory(t.ctx, cat(COFFEE))).toEqual({
      ok: false,
      reason: 'has_rules',
      message: `有 ${n} 条规则指向这个分类，先去规则页改掉或删掉`,
      ruleCount: n,
      ruleFilterTopId: cat(ENT),
    });
    expect(await categoryRows()).toEqual(before);
  });

  it('R19.4: archive Coffee & tea (rules deleted first) → dashboard unchanged, tree hides it unless asked', async () => {
    await importFixture('CBA Female', 'cba/female-2026-09.csv');
    await deleteRulesFor([cat(COFFEE)]);

    const dashBefore = await getDashboard(t.ctx, { period: SEPT }, TODAY);
    const pivotInput = {
      period: SEPT,
      granularity: 'month',
      groupBy: 'category',
      metric: 'expense',
    } as const;
    const pivotBefore = await getPivot(t.ctx, pivotInput, TODAY);
    // fixtures 里 OVERLAY COFFEE MELBOURNE 是 Coffee & tea，归档前后都要算进去
    const coffeeSplits = (await splitRows()).filter((s) => s.categoryId === cat(COFFEE));
    expect(coffeeSplits.length).toBeGreaterThan(0);

    expect(await archiveCategory(t.ctx, cat(COFFEE))).toEqual({ ok: true, ids: [cat(COFFEE)] });
    expect((await categoryRow(cat(COFFEE))).isArchived).toBe(true);

    expect(await getDashboard(t.ctx, { period: SEPT }, TODAY)).toEqual(dashBefore);
    expect(await getPivot(t.ctx, pivotInput, TODAY)).toEqual(pivotBefore);

    const tree = await listCategoryTree(t.ctx);
    const ent = tree.find((c) => c.id === cat(ENT))!;
    expect(ent.children.map((c) => c.id)).not.toContain(cat(COFFEE));
    expect(ent.children.every((c) => !c.isArchived)).toBe(true);

    const full = await listCategoryTree(t.ctx, { includeArchived: true });
    const coffee = full.find((c) => c.id === cat(ENT))!.children.find((c) => c.id === cat(COFFEE));
    expect(coffee).toMatchObject({ nameEn: 'Coffee & tea', isArchived: true });
  });

  it('R19.4: a rule pointing at a child blocks archiving the top; after deleting them the top and all children are archived', async () => {
    const entChildren = t.h.categories.filter((c) => c.parentId === cat(ENT)).map((c) => c.id);
    const n = rulesPointingAt([cat(ENT), ...entChildren]);
    expect(await archiveCategory(t.ctx, cat(ENT))).toMatchObject({
      ok: false,
      reason: 'has_rules',
      ruleCount: n,
    });

    await deleteRulesFor([cat(ENT), ...entChildren]);
    const r = await archiveCategory(t.ctx, cat(ENT));
    expect(r.ok && [...r.ids].sort()).toEqual([cat(ENT), ...entChildren].sort());

    const rows = await childrenOf(cat(ENT));
    expect(rows.every((c) => c.isArchived)).toBe(true);
    expect((await categoryRow(cat(ENT))).isArchived).toBe(true);

    // 默认的树里一级和二级都没有；带归档时一级、二级都标归档
    expect((await listCategoryTree(t.ctx)).map((c) => c.id)).not.toContain(cat(ENT));
    const ent = (await listCategoryTree(t.ctx, { includeArchived: true })).find(
      (c) => c.id === cat(ENT),
    )!;
    expect(ent.isArchived).toBe(true);
    expect(ent.children.every((c) => c.isArchived)).toBe(true);
  });

  it('R19.4: unarchive — child of an archived top is rejected; unarchiving the top brings all children back', async () => {
    const entChildren = t.h.categories.filter((c) => c.parentId === cat(ENT)).map((c) => c.id);
    await deleteRulesFor([cat(ENT), ...entChildren]);
    await archiveCategory(t.ctx, cat(COFFEE)); // 先单独归档过
    await archiveCategory(t.ctx, cat(ENT));

    const before = await categoryRows();
    expect(await unarchiveCategory(t.ctx, cat(COFFEE))).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await categoryRows()).toEqual(before);

    const r = await unarchiveCategory(t.ctx, cat(ENT));
    expect(r.ok && [...r.ids].sort()).toEqual([cat(ENT), ...entChildren].sort());
    expect((await childrenOf(cat(ENT))).every((c) => !c.isArchived)).toBe(true);
  });

  it('R19.4: system category and Other cannot be archived', async () => {
    expect(await archiveCategory(t.ctx, t.h.systemCategory('uncategorized').id)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await archiveCategory(t.ctx, cat(`${ENT} / Other`))).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  // ---------- R19.1 列表 ----------

  it('R19.1: grouped by expense, income, system; top counts include children; archived are listed', async () => {
    await importFixture('CBA Female', 'cba/female-2026-09.csv');
    await deleteRulesFor([cat(COFFEE)]);
    await archiveCategory(t.ctx, cat(COFFEE));

    const list = await listCategoriesForAdmin(t.ctx);
    expect(list.expense.every((c) => c.kind === 'expense')).toBe(true);
    expect(list.income.every((c) => c.kind === 'income')).toBe(true);
    expect(list.system.map((c) => c.systemKey).sort()).toEqual(
      ['bank_fee', 'cash_withdrawal', 'internal_transfer', 'uncategorized'].sort(),
    );

    const ent = list.expense.find((c) => c.id === cat(ENT))!;
    const coffee = ent.children.find((c) => c.id === cat(COFFEE))!;
    expect(coffee.isArchived).toBe(true);
    expect(coffee.ruleCount).toBe(0);
    expect(coffee.splitCount).toBe(
      (await splitRows()).filter((s) => s.categoryId === cat(COFFEE)).length,
    );
    expect(ent.ruleCount).toBe(ent.children.reduce((n, c) => n + c.ruleCount, 0));
    expect(ent.splitCount).toBe(ent.children.reduce((n, c) => n + c.splitCount, 0));

    const restaurants = ent.children.find((c) => c.nameEn === 'Restaurants')!;
    expect(restaurants.ruleCount).toBe(rulesPointingAt([restaurants.id]));
  });

  // ---------- household_id ----------

  it('another household: not listed; update, archive and unarchive return not_found and change nothing', async () => {
    const other = await otherHousehold();
    const otherRows = () =>
      db
        .select()
        .from(schema.category)
        .where(eq(schema.category.householdId, other.householdId))
        .orderBy(schema.category.id);
    const before = await otherRows();

    const list = await listCategoriesForAdmin(t.ctx);
    const ids = [...list.expense, ...list.income, ...list.system].map((c) => c.id);
    expect(ids).not.toContain(other.topId);
    expect(
      (await listCategoryTree(t.ctx, { includeArchived: true })).map((c) => c.id),
    ).not.toContain(other.topId);

    const notFound = { ok: false, reason: 'not_found', message: '分类不存在' };
    expect(await updateCategory(t.ctx, other.topId, { nameEn: 'Hijack' })).toEqual(notFound);
    expect(await archiveCategory(t.ctx, other.topId)).toEqual(notFound);
    expect(await unarchiveCategory(t.ctx, other.topId)).toEqual(notFound);
    expect(await otherRows()).toEqual(before);
  });

  it('bad category id (not a uuid) is not_found', async () => {
    expect(await updateCategory(t.ctx, 'nope', { nameEn: 'X' })).toMatchObject({
      reason: 'not_found',
    });
    expect(await archiveCategory(t.ctx, 'nope')).toMatchObject({ reason: 'not_found' });
    expect(await unarchiveCategory(t.ctx, 'nope')).toMatchObject({ reason: 'not_found' });
  });
});
