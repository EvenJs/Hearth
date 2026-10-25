// M4-4 存成规则和重新应用（business-rules.md R13、R7.2、R16.6、R5.1）
// 期望值来自 docs/tasks/m4.md M4-4 完成标准和 fixtures/README.md（joint、拆分用例）
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { importCsv } from '@/server/imports';
import { createRule, previewReapply, reapplyRules } from '@/server/rules';
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

const RESTAURANTS = 'Entertainment & eat-out / Restaurants';

async function importJoint(): Promise<void> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account('ANZ Joint').id,
    fileName: 'anz/joint-2026-09.csv',
    text: readFixture('anz/joint-2026-09.csv'),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
}

async function txIdByMerchant(merchant: string): Promise<string> {
  const rows = await db
    .select({ id: schema.transaction.id })
    .from(schema.transaction)
    .where(
      and(
        eq(schema.transaction.householdId, t.ctx.householdId),
        eq(schema.transaction.merchant, merchant),
      ),
    );
  if (rows.length === 0) throw new Error(`${merchant} 没有`);
  return rows[0].id;
}

async function primarySplitId(merchant: string): Promise<string> {
  const splits = await getSplits(await txIdByMerchant(merchant));
  return splits.find((s) => s.isPrimary)!.id;
}

// 所有拆分，按 merchant 排，换成名字方便比较
async function describeAll() {
  const rows = await db
    .select({
      merchant: schema.transaction.merchant,
      splitId: schema.transactionSplit.id,
      isPrimary: schema.transactionSplit.isPrimary,
      amountCents: schema.transactionSplit.amountCents,
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
      isPrimary: r.isPrimary,
      amountCents: r.amountCents,
      category: parent ? `${parent.nameEn} / ${cat.nameEn}` : cat.nameEn,
      categorySource: r.categorySource,
      member: t.h.members.find((m) => m.id === r.memberId)!.name,
      memberSource: r.memberSource,
      isPreTax: r.isPreTax,
    };
  });
}

// 前后两次快照里变了的拆分
function changedSplits(
  before: Awaited<ReturnType<typeof describeAll>>,
  after: Awaited<ReturnType<typeof describeAll>>,
) {
  return after.filter((a) => {
    const b = before.find((x) => x.splitId === a.splitId)!;
    return JSON.stringify(a) !== JSON.stringify(b);
  });
}

async function ruleRows() {
  return db
    .select()
    .from(schema.categoryRule)
    .where(eq(schema.categoryRule.householdId, t.ctx.householdId));
}

// fixtures/README.md "拆分（R15）"：#19 主拆分 -3540（仍是 rule 来源），再加两个 manual 拆分
async function splitColes(): Promise<string> {
  const id = await txIdByMerchant('COLES 0559 MELBOURNE');
  const { ctx, h } = t;
  await db.transaction(async (tx) => {
    await tx
      .update(schema.transactionSplit)
      .set({ amountCents: -3540 })
      .where(
        and(
          eq(schema.transactionSplit.transactionId, id),
          eq(schema.transactionSplit.isPrimary, true),
        ),
      );
    await tx.insert(schema.transactionSplit).values([
      {
        householdId: ctx.householdId,
        transactionId: id,
        amountCents: -1500,
        categoryId: h.category('Home & utilities / Household supplies').id,
        memberId: h.member('Home').id,
        categorySource: 'manual',
        memberSource: 'category',
        isPrimary: false,
        isPreTax: false,
      },
      {
        householdId: ctx.householdId,
        transactionId: id,
        amountCents: -800,
        categoryId: h.category('Personal & medical / Cosmetics & toiletries').id,
        memberId: h.member('Male').id,
        categorySource: 'manual',
        memberSource: 'card',
        isPrimary: false,
        isPreTax: false,
      },
    ]);
  });
  return id;
}

describeDb('M4-4 createRule / previewReapply / reapplyRules', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  // ---------- 完成标准 ----------

  it('R13 + R7.2: #15 changed by hand, rule UNKNOWN SHOP saved and applied: #15 (manual) stays, only uncategorised and rule ones change', async () => {
    await importJoint();
    const restaurants = t.h.category(RESTAURANTS).id;
    await updateSplitCategory(
      t.ctx,
      await primarySplitId('UNKNOWN SHOP PTY LTD MELBOURNE'),
      restaurants,
    );

    expect(
      await createRule(t.ctx, {
        keyword: 'unknown shop',
        matchType: 'contains',
        categoryId: restaurants,
      }),
    ).toMatchObject({ ok: true, status: 'created' });
    expect((await ruleRows()).find((r) => r.keyword === 'UNKNOWN SHOP')).toMatchObject({
      matchType: 'contains',
      categoryId: restaurants,
      isSystem: false,
      priority: 0,
    });

    // 只有 #15 命中 UNKNOWN SHOP，它是 manual，所以什么都不改
    const before = await describeAll();
    expect(await previewReapply(t.ctx)).toEqual({ changeCount: 0, skippedCount: 0 });
    expect(await reapplyRules(t.ctx)).toEqual({ updatedCount: 0, skippedCount: 0 });
    expect(await describeAll()).toEqual(before);

    // 再加两条：EASI 命中未分类的 #16；GONG CHA & HO 比预置的 GONG CHA 长，命中 rule 来源的 #4、#5
    // 银行费用（system）、ATM（system）、#15（manual）不在这两条规则里，也不动
    await createRule(t.ctx, { keyword: 'EASI', matchType: 'contains', categoryId: restaurants });
    await createRule(t.ctx, {
      keyword: 'GONG CHA & HO',
      matchType: 'starts_with',
      categoryId: restaurants,
    });

    expect(await previewReapply(t.ctx)).toEqual({ changeCount: 3, skippedCount: 0 });
    expect(await reapplyRules(t.ctx)).toEqual({ updatedCount: 3, skippedCount: 0 });

    const changed = changedSplits(before, await describeAll());
    // Restaurants 没有分类默认 → R5.1 按卡号：2222 Female、1111 Male
    expect(
      changed
        .map((c) => [c.merchant, c.category, c.categorySource, c.member, c.memberSource])
        .sort(),
    ).toEqual(
      [
        ['EASI AU ****2605', RESTAURANTS, 'rule', 'Female', 'card'],
        ['GONG CHA & HO/SPENCER ST MELBOURNE', RESTAURANTS, 'rule', 'Male', 'card'],
        ['GONG CHA & HO/SPENCER ST MELBOURNE', RESTAURANTS, 'rule', 'Male', 'card'],
      ].sort(),
    );

    // 应用完再预览：没有要改的了
    expect(await previewReapply(t.ctx)).toEqual({ changeCount: 0, skippedCount: 0 });
  });

  it('R7.2: a COLES row changed by hand first is not touched by reapply', async () => {
    await importJoint();
    const colesSplit = await primarySplitId('COLES 0559 MELBOURNE');
    await updateSplitCategory(t.ctx, colesSplit, t.h.category(RESTAURANTS).id);

    // 预置规则 COLES 仍然指向 Supermarket，再加一条更长的也一样
    await createRule(t.ctx, {
      keyword: 'COLES 0559',
      matchType: 'contains',
      categoryId: t.h.category('Groceries / Supermarket').id,
    });
    const before = await describeAll();
    await reapplyRules(t.ctx);
    const after = await describeAll();
    expect(after).toEqual(before);
    expect(after.find((s) => s.splitId === colesSplit)).toMatchObject({
      category: RESTAURANTS,
      categorySource: 'manual',
    });
  });

  it('R7.2: a transaction with multiple splits is skipped and counted', async () => {
    await importJoint();
    const colesId = await splitColes();
    const before = await getSplits(colesId);

    // 主拆分是 rule 来源，单拆分的话会被改成 Restaurants
    await createRule(t.ctx, {
      keyword: 'COLES 0559',
      matchType: 'contains',
      categoryId: t.h.category(RESTAURANTS).id,
    });
    expect(await previewReapply(t.ctx)).toEqual({ changeCount: 0, skippedCount: 1 });
    expect(await reapplyRules(t.ctx)).toEqual({ updatedCount: 0, skippedCount: 1 });
    expect(await getSplits(colesId)).toEqual(before);
  });

  // ---------- R16.6 关键词已经存在 ----------

  it('R16.6: same keyword and category → unchanged, nothing written', async () => {
    const coles = (await ruleRows()).find((r) => r.keyword === 'COLES')!;
    const r = await createRule(t.ctx, {
      keyword: ' coles ',
      matchType: 'contains',
      categoryId: t.h.category('Groceries / Supermarket').id,
    });
    expect(r).toEqual({ ok: true, status: 'unchanged', ruleId: coles.id });
    expect(await ruleRows()).toHaveLength(t.h.rules.length);
  });

  it('R16.6: different category → conflict message, then overwrite updates the seed rule', async () => {
    const before = await ruleRows();
    const coles = before.find((r) => r.keyword === 'COLES')!;
    const restaurants = t.h.category(RESTAURANTS).id;

    const r = await createRule(t.ctx, {
      keyword: 'COLES',
      matchType: 'contains',
      categoryId: restaurants,
    });
    expect(r).toEqual({
      ok: false,
      reason: 'conflict',
      message: '已有规则 COLES → Groceries / Supermarket',
      existing: {
        id: coles.id,
        keyword: 'COLES',
        matchType: 'contains',
        categoryId: t.h.category('Groceries / Supermarket').id,
        categoryLabel: 'Groceries / Supermarket',
      },
    });
    expect(await ruleRows()).toEqual(before);

    const r2 = await createRule(t.ctx, {
      keyword: 'COLES',
      matchType: 'contains',
      categoryId: restaurants,
      overwrite: true,
    });
    expect(r2).toEqual({ ok: true, status: 'updated', ruleId: coles.id });
    const after = (await ruleRows()).find((x) => x.id === coles.id)!;
    expect(after).toMatchObject({ categoryId: restaurants, isSystem: true });
    expect(await ruleRows()).toHaveLength(before.length);
  });

  it('R16.6: same keyword with a different match_type is a new rule', async () => {
    const r = await createRule(t.ctx, {
      keyword: 'COLES',
      matchType: 'starts_with',
      categoryId: t.h.category(RESTAURANTS).id,
    });
    expect(r).toMatchObject({ ok: true, status: 'created' });
    expect(await ruleRows()).toHaveLength(t.h.rules.length + 1);
  });

  // ---------- 校验 ----------

  it('keyword is trimmed, spaces collapsed, upper-cased; empty is rejected', async () => {
    const restaurants = t.h.category(RESTAURANTS).id;
    await createRule(t.ctx, {
      keyword: '  pochana   melbourne ',
      matchType: 'contains',
      categoryId: restaurants,
    });
    expect((await ruleRows()).some((r) => r.keyword === 'POCHANA MELBOURNE')).toBe(true);

    const r = await createRule(t.ctx, {
      keyword: '   ',
      matchType: 'contains',
      categoryId: restaurants,
    });
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('R16.3: internal transfer, archived and other-household categories are rejected', async () => {
    const before = await ruleRows();
    const [other] = await db
      .insert(schema.household)
      .values({ name: 'Other Household' })
      .returning({ id: schema.household.id });
    const [otherCategory] = await db
      .insert(schema.category)
      .values({ householdId: other.id, nameEn: 'Stranger things', kind: 'expense' })
      .returning({ id: schema.category.id });
    const restaurants = t.h.category(RESTAURANTS);
    await db
      .update(schema.category)
      .set({ isArchived: true })
      .where(eq(schema.category.id, restaurants.id));

    for (const categoryId of [
      t.h.systemCategory('internal_transfer').id,
      restaurants.id,
      otherCategory.id,
    ]) {
      const r = await createRule(t.ctx, {
        keyword: 'SOMETHING',
        matchType: 'contains',
        categoryId,
      });
      expect(r).toMatchObject({ ok: false, reason: 'invalid' });
    }
    expect(await ruleRows()).toEqual(before);
  });

  it('reapply is scoped to household_id: another household changes nothing here', async () => {
    await importJoint();
    await createRule(t.ctx, {
      keyword: 'EASI',
      matchType: 'contains',
      categoryId: t.h.category(RESTAURANTS).id,
    });
    const [other] = await db
      .insert(schema.household)
      .values({ name: 'Other Household' })
      .returning({ id: schema.household.id });
    const otherCtx = { ...t.ctx, householdId: other.id, memberId: null };

    const before = await describeAll();
    // 另一个家庭读不到本家庭的分类（连未分类都没有），直接报错，本家庭什么都不改
    await expect(previewReapply(otherCtx)).rejects.toThrow('uncategorized');
    await expect(reapplyRules(otherCtx)).rejects.toThrow('uncategorized');
    expect(await describeAll()).toEqual(before);
    // 本家庭自己应用：#16 被改
    expect(await reapplyRules(t.ctx)).toEqual({ updatedCount: 1, skippedCount: 0 });
  });
});
