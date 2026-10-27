// M6.5-3 设置 → 规则的数据层（business-rules.md R18、R7.2、R5.1）
// 期望值来自 docs/tasks/m6.5.md M6.5-3 完成标准和 R18.4 的例子表
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { importCsv } from '@/server/imports';
import {
  createRuleFromSettings,
  deleteRule,
  listRules,
  previewReapply,
  reapplyRules,
  updateRule,
} from '@/server/rules';
import { readFixture } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

let t: DbTestHousehold;

const COFFEE = 'Entertainment & eat-out / Coffee & tea';
const RESTAURANTS = 'Entertainment & eat-out / Restaurants';

// R18.4 例子的交易：fixtures 里没有含 CAFE 的商家，这里导一行假的 ANZ CSV 进 ANZ Joint
// 走完整的导入，R7 把它分到 CAFE → Coffee & tea（rule）；没有卡号 → Home（account）
const BLUE_CAFE_CSV = '15/10/2026,"-6.50",BLUE CAFE BAR\n';

async function importCsvText(fileName: string, text: string): Promise<void> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account('ANZ Joint').id,
    fileName,
    text,
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
}

const importBlueCafe = () => importCsvText('blue-cafe.csv', BLUE_CAFE_CSV);
const importJoint = () =>
  importCsvText('anz/joint-2026-09.csv', readFixture('anz/joint-2026-09.csv'));

// 本家庭所有拆分，换成名字方便比较
async function splits() {
  const rows = await db
    .select({
      merchant: schema.transaction.merchant,
      splitId: schema.transactionSplit.id,
      categoryId: schema.transactionSplit.categoryId,
      categorySource: schema.transactionSplit.categorySource,
      memberId: schema.transactionSplit.memberId,
      memberSource: schema.transactionSplit.memberSource,
      isPreTax: schema.transactionSplit.isPreTax,
    })
    .from(schema.transactionSplit)
    .innerJoin(schema.transaction, eq(schema.transaction.id, schema.transactionSplit.transactionId))
    .where(eq(schema.transactionSplit.householdId, t.ctx.householdId))
    .orderBy(schema.transactionSplit.id);
  return rows.map((r) => {
    const cat = t.h.categories.find((c) => c.id === r.categoryId)!;
    const parent = cat.parentId ? t.h.categories.find((c) => c.id === cat.parentId)! : null;
    return {
      merchant: r.merchant,
      splitId: r.splitId,
      category: parent ? `${parent.nameEn} / ${cat.nameEn}` : cat.nameEn,
      categorySource: r.categorySource,
      member: t.h.members.find((m) => m.id === r.memberId)!.name,
      memberSource: r.memberSource,
      isPreTax: r.isPreTax,
    };
  });
}

async function blueCafe() {
  const rows = (await splits()).filter((s) => s.merchant === 'BLUE CAFE BAR');
  if (rows.length !== 1) throw new Error(`BLUE CAFE BAR 应该只有一个拆分，实际 ${rows.length}`);
  const { category, categorySource, member, memberSource } = rows[0];
  return { category, categorySource, member, memberSource };
}

async function ruleRows() {
  return db
    .select()
    .from(schema.categoryRule)
    .where(eq(schema.categoryRule.householdId, t.ctx.householdId))
    .orderBy(schema.categoryRule.id);
}

const ruleId = (keyword: string) => t.h.rules.find((r) => r.keyword === keyword)!.id;
const cafeRule = () => t.h.rules.find((r) => r.keyword === 'CAFE')!;

// 另一个家庭：一个分类、一条规则
async function otherHousehold() {
  const [hh] = await db
    .insert(schema.household)
    .values({ name: 'Other Household' })
    .returning({ id: schema.household.id });
  const [cat] = await db
    .insert(schema.category)
    .values({ householdId: hh.id, nameEn: 'Other top', kind: 'expense', sortOrder: 0 })
    .returning({ id: schema.category.id });
  const [rule] = await db
    .insert(schema.categoryRule)
    .values({ householdId: hh.id, keyword: 'OTHER SHOP', categoryId: cat.id })
    .returning({ id: schema.categoryRule.id });
  return { householdId: hh.id, categoryId: cat.id, ruleId: rule.id };
}

describeDb('M6.5-3 listRules / createRuleFromSettings / updateRule / deleteRule', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  // ---------- R18.4 例子 ----------

  it('R18.4 setup: BLUE CAFE BAR is imported as Coffee & tea (rule), Home (account)', async () => {
    await importBlueCafe();
    expect(await blueCafe()).toEqual({
      category: COFFEE,
      categorySource: 'rule',
      member: 'Home',
      memberSource: 'account',
    });
  });

  it('R18.4 + R18.3 delete CAFE, not applied: still Coffee & tea, category_source still rule', async () => {
    await importBlueCafe();
    expect(await deleteRule(t.ctx, cafeRule().id)).toEqual({ ok: true, ruleId: cafeRule().id });
    expect(await blueCafe()).toMatchObject({ category: COFFEE, categorySource: 'rule' });
  });

  it('R18.4 delete CAFE, applied: becomes Uncategorised', async () => {
    await importBlueCafe();
    await deleteRule(t.ctx, cafeRule().id);
    expect(await previewReapply(t.ctx)).toEqual({ changeCount: 1, skippedCount: 0 });
    expect(await reapplyRules(t.ctx)).toEqual({ updatedCount: 1, skippedCount: 0 });
    expect(await blueCafe()).toEqual({
      category: 'Uncategorised',
      categorySource: 'system',
      member: 'Home',
      memberSource: 'account',
    });
  });

  it('R18.4 rename CAFE → BLUE CAFE, not applied: still Coffee & tea', async () => {
    await importBlueCafe();
    const r = await updateRule(t.ctx, cafeRule().id, {
      keyword: 'blue cafe',
      matchType: 'contains',
      categoryId: t.h.category(COFFEE).id,
    });
    expect(r).toEqual({ ok: true, ruleId: cafeRule().id });
    expect(await blueCafe()).toMatchObject({ category: COFFEE, categorySource: 'rule' });
  });

  it('R18.4 rename CAFE → BLUE CAFE, applied: still Coffee & tea (new keyword still matches), nothing to change', async () => {
    await importBlueCafe();
    await updateRule(t.ctx, cafeRule().id, {
      keyword: 'BLUE CAFE',
      matchType: 'contains',
      categoryId: t.h.category(COFFEE).id,
    });
    expect(await previewReapply(t.ctx)).toEqual({ changeCount: 0, skippedCount: 0 });
    expect(await reapplyRules(t.ctx)).toEqual({ updatedCount: 0, skippedCount: 0 });
    expect(await blueCafe()).toMatchObject({ category: COFFEE, categorySource: 'rule' });
  });

  it('R18.4 CAFE category → Restaurants, not applied: still Coffee & tea', async () => {
    await importBlueCafe();
    await updateRule(t.ctx, cafeRule().id, {
      keyword: 'CAFE',
      matchType: 'contains',
      categoryId: t.h.category(RESTAURANTS).id,
    });
    expect(await blueCafe()).toMatchObject({ category: COFFEE, categorySource: 'rule' });
  });

  it('R18.4 + R5.1 CAFE category → Restaurants, applied: Restaurants (rule), member recomputed → Home (account)', async () => {
    await importBlueCafe();
    await updateRule(t.ctx, cafeRule().id, {
      keyword: 'CAFE',
      matchType: 'contains',
      categoryId: t.h.category(RESTAURANTS).id,
    });
    expect(await reapplyRules(t.ctx)).toEqual({ updatedCount: 1, skippedCount: 0 });
    expect(await blueCafe()).toEqual({
      category: RESTAURANTS,
      categorySource: 'rule',
      member: 'Home',
      memberSource: 'account',
    });
  });

  it('R18.2: update keeps priority, is_system and created_at', async () => {
    const before = (await ruleRows()).find((r) => r.id === cafeRule().id)!;
    await updateRule(t.ctx, cafeRule().id, {
      keyword: 'BLUE CAFE',
      matchType: 'starts_with',
      categoryId: t.h.category(RESTAURANTS).id,
    });
    const after = (await ruleRows()).find((r) => r.id === cafeRule().id)!;
    expect(after).toEqual({
      ...before,
      keyword: 'BLUE CAFE',
      matchType: 'starts_with',
      categoryId: t.h.category(RESTAURANTS).id,
    });
  });

  // ---------- R18.2 新建 ----------

  it('R18.2: create from settings normalizes keyword, priority 0, not system, can be starts_with', async () => {
    const r = await createRuleFromSettings(t.ctx, {
      keyword: '  blue   door ',
      matchType: 'starts_with',
      categoryId: t.h.category(COFFEE).id,
    });
    if (!r.ok) throw new Error(r.message);
    const row = (await ruleRows()).find((x) => x.id === r.ruleId)!;
    expect(row).toMatchObject({
      keyword: 'BLUE DOOR',
      matchType: 'starts_with',
      categoryId: t.h.category(COFFEE).id,
      priority: 0,
      isSystem: false,
    });
  });

  it('R18.2: CAFE starts_with can be created next to CAFE contains', async () => {
    const r = await createRuleFromSettings(t.ctx, {
      keyword: 'CAFE',
      matchType: 'starts_with',
      categoryId: t.h.category(COFFEE).id,
    });
    expect(r.ok).toBe(true);
  });

  it('R18.2: empty keyword, Internal transfer and archived category are rejected, nothing written', async () => {
    const before = await ruleRows();
    await db
      .update(schema.category)
      .set({ isArchived: true })
      .where(eq(schema.category.id, t.h.category('Entertainment & eat-out').id));

    expect(
      await createRuleFromSettings(t.ctx, {
        keyword: '   ',
        matchType: 'contains',
        categoryId: t.h.category(RESTAURANTS).id,
      }),
    ).toEqual({ ok: false, reason: 'invalid', message: '关键词不能为空' });
    expect(
      await createRuleFromSettings(t.ctx, {
        keyword: 'NEW SHOP',
        matchType: 'contains',
        categoryId: t.h.systemCategory('internal_transfer').id,
      }),
    ).toEqual({ ok: false, reason: 'invalid', message: '不能选这个分类' });
    // 一级归档了，下面的二级也不能选（R16.3）
    expect(
      await createRuleFromSettings(t.ctx, {
        keyword: 'NEW SHOP',
        matchType: 'contains',
        categoryId: t.h.category(RESTAURANTS).id,
      }),
    ).toEqual({ ok: false, reason: 'invalid', message: '不能选这个分类' });
    expect(await ruleRows()).toEqual(before);
  });

  // ---------- R18.2 撞关键词 ----------

  it('R18.2: create with an existing keyword is a conflict naming the existing category, nothing written', async () => {
    const before = await ruleRows();
    const r = await createRuleFromSettings(t.ctx, {
      keyword: 'coles',
      matchType: 'contains',
      categoryId: t.h.category(RESTAURANTS).id,
    });
    expect(r).toEqual({
      ok: false,
      reason: 'conflict',
      message: '已有规则 COLES → Groceries / Supermarket',
      conflictRuleId: ruleId('COLES'),
    });
    expect(await ruleRows()).toEqual(before);
  });

  it('R18.2: changing CAFE keyword to COFFEE (another rule) is a conflict, rules and transactions unchanged', async () => {
    await importJoint();
    await importBlueCafe();
    const rulesBefore = await ruleRows();
    const splitsBefore = await splits();

    const r = await updateRule(t.ctx, cafeRule().id, {
      keyword: 'COFFEE',
      matchType: 'contains',
      categoryId: t.h.category(RESTAURANTS).id,
    });
    expect(r).toEqual({
      ok: false,
      reason: 'conflict',
      message: `已有规则 COFFEE → ${COFFEE}`,
      conflictRuleId: ruleId('COFFEE'),
    });
    expect(await ruleRows()).toEqual(rulesBefore);
    expect(await splits()).toEqual(splitsBefore);
  });

  it('R18.2: changing only the category of a rule (same keyword) is not a conflict', async () => {
    const r = await updateRule(t.ctx, ruleId('COLES'), {
      keyword: 'COLES',
      matchType: 'contains',
      categoryId: t.h.category(RESTAURANTS).id,
    });
    expect(r).toEqual({ ok: true, ruleId: ruleId('COLES') });
  });

  // ---------- R18.1 列表 ----------

  it('R18.1: list has label, top category id, hits and is_system, sorted by keyword', async () => {
    await importJoint();
    await importBlueCafe();
    const list = await listRules(t.ctx);

    expect(list).toHaveLength(t.h.rules.length);
    const keys = list.map((r) => r.keyword);
    expect(keys).toEqual([...keys].sort());

    expect(list.find((r) => r.keyword === 'CAFE')).toEqual({
      id: cafeRule().id,
      keyword: 'CAFE',
      matchType: 'contains',
      categoryId: t.h.category(COFFEE).id,
      categoryLabel: COFFEE,
      topCategoryId: t.h.category('Entertainment & eat-out').id,
      hits: 1,
      isSystem: true,
    });
    // joint #19 COLES 0559 MELBOURNE
    expect(list.find((r) => r.keyword === 'COLES')?.hits).toBeGreaterThanOrEqual(1);
  });

  it('R18.1: hits count a manually recategorised transaction', async () => {
    await importBlueCafe();
    await db
      .update(schema.transactionSplit)
      .set({ categoryId: t.h.category(RESTAURANTS).id, categorySource: 'manual' })
      .where(eq(schema.transactionSplit.householdId, t.ctx.householdId));
    const list = await listRules(t.ctx);
    expect(list.find((r) => r.keyword === 'CAFE')?.hits).toBe(1);
  });

  // ---------- household_id ----------

  it('another household: its rules are not listed, update and delete return not_found and change nothing', async () => {
    const other = await otherHousehold();
    const otherBefore = await db
      .select()
      .from(schema.categoryRule)
      .where(eq(schema.categoryRule.householdId, other.householdId));

    expect((await listRules(t.ctx)).map((r) => r.id)).not.toContain(other.ruleId);
    expect(
      await updateRule(t.ctx, other.ruleId, {
        keyword: 'HIJACK',
        matchType: 'contains',
        categoryId: t.h.category(COFFEE).id,
      }),
    ).toEqual({ ok: false, reason: 'not_found', message: '规则不存在' });
    expect(await deleteRule(t.ctx, other.ruleId)).toEqual({
      ok: false,
      reason: 'not_found',
      message: '规则不存在',
    });
    // 本家庭的规则不能指向别的家庭的分类
    expect(
      await createRuleFromSettings(t.ctx, {
        keyword: 'NEW SHOP',
        matchType: 'contains',
        categoryId: other.categoryId,
      }),
    ).toEqual({ ok: false, reason: 'invalid', message: '不能选这个分类' });

    expect(
      await db
        .select()
        .from(schema.categoryRule)
        .where(eq(schema.categoryRule.householdId, other.householdId)),
    ).toEqual(otherBefore);
  });

  it('bad rule id (not a uuid) is not_found', async () => {
    expect(await deleteRule(t.ctx, 'nope')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('delete only removes that rule', async () => {
    const before = await ruleRows();
    await deleteRule(t.ctx, cafeRule().id);
    const after = await ruleRows();
    expect(after).toEqual(before.filter((r) => r.id !== cafeRule().id));
    const [gone] = await db
      .select()
      .from(schema.categoryRule)
      .where(
        and(
          eq(schema.categoryRule.id, cafeRule().id),
          eq(schema.categoryRule.householdId, t.ctx.householdId),
        ),
      );
    expect(gone).toBeUndefined();
  });
});
