// M4-6 拆分（business-rules.md R15、R5、R16.2、R16.3、R16.4）
// 期望值来自 docs/tasks/m4.md M4-6 完成标准、business-rules.md R15.5 和 fixtures/README.md "拆分（R15）"
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { importCsv } from '@/server/imports';
import { addSplit, removeSplit, updateSplit } from '@/server/splits';
import { readFixture } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { getSplits, getTransaction } from './helpers/transactions';

let t: DbTestHousehold;

const SUPPLIES = 'Home & utilities / Household supplies';
const COSMETICS = 'Personal & medical / Cosmetics & toiletries';

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
  if (rows.length !== 1) throw new Error(`${merchant} 有 ${rows.length} 笔`);
  return rows[0].id;
}

function categoryPath(id: string): string {
  const c = t.h.categories.find((x) => x.id === id)!;
  const parent = c.parentId ? t.h.categories.find((x) => x.id === c.parentId)! : null;
  return parent ? `${parent.nameEn} / ${c.nameEn}` : c.nameEn;
}

// 拆分换成名字，主拆分在前，其他按金额绝对值从大到小
// 顺便检查 R15.1：合计 = 交易金额，恰好一个主拆分
async function splitsOf(transactionId: string) {
  const tx = await getTransaction(transactionId);
  const rows = await getSplits(transactionId);
  expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(tx.amountCents);
  expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);
  return rows
    .sort(
      (a, b) =>
        Number(b.isPrimary) - Number(a.isPrimary) ||
        Math.abs(b.amountCents) - Math.abs(a.amountCents),
    )
    .map((r) => ({
      id: r.id,
      isPrimary: r.isPrimary,
      amountCents: r.amountCents,
      category: categoryPath(r.categoryId),
      categorySource: r.categorySource,
      member: t.h.members.find((m) => m.id === r.memberId)!.name,
      memberSource: r.memberSource,
      isPreTax: r.isPreTax,
      note: r.note,
    }));
}

const brief = (s: Awaited<ReturnType<typeof splitsOf>>) =>
  s.map((x) => [
    x.isPrimary ? '主' : '',
    x.amountCents,
    x.category,
    `${x.member} (${x.memberSource})`,
  ]);

describeDb('M4-6 addSplit / updateSplit / removeSplit', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  // ---------- 完成标准：R15.5 和 fixtures/README 拆分用例 ----------

  it('R15.5: the #19 COLES split case step by step', async () => {
    await importJoint();
    const coles = await txIdByMerchant('COLES 0559 MELBOURNE');
    expect(brief(await splitsOf(coles))).toEqual([
      ['主', -5840, 'Groceries / Supermarket', 'Home (category)'],
    ]);

    // 拆出 15.00 → Household supplies，不选归属人
    const r1 = await addSplit(t.ctx, coles, {
      amountCents: 1500,
      categoryId: t.h.category(SUPPLIES).id,
    });
    expect(r1.ok).toBe(true);
    expect(brief(await splitsOf(coles))).toEqual([
      ['主', -4340, 'Groceries / Supermarket', 'Home (category)'],
      ['', -1500, SUPPLIES, 'Home (category)'],
    ]);

    // 再拆出 8.00 → Cosmetics & toiletries，不选归属人 → Male（card 1111）
    const r2 = await addSplit(t.ctx, coles, {
      amountCents: 800,
      categoryId: t.h.category(COSMETICS).id,
    });
    expect(r2.ok).toBe(true);
    const after2 = await splitsOf(coles);
    expect(brief(after2)).toEqual([
      ['主', -3540, 'Groceries / Supermarket', 'Home (category)'],
      ['', -1500, SUPPLIES, 'Home (category)'],
      ['', -800, COSMETICS, 'Male (card)'],
    ]);
    // 新拆分 category_source = manual，is_pre_tax 按新分类默认
    expect(after2.slice(1).map((s) => [s.categorySource, s.isPreTax])).toEqual([
      ['manual', false],
      ['manual', false],
    ]);
    if (!r2.ok) throw new Error('unreachable');
    expect(after2[2].id).toBe(r2.splitId);

    // 拆出 50.00 → 报错，超过主拆分 35.40，什么都不改
    const r3 = await addSplit(t.ctx, coles, {
      amountCents: 5000,
      categoryId: t.h.category(SUPPLIES).id,
    });
    expect(r3).toEqual({ ok: false, message: '拆出金额必须小于主拆分当前金额 $35.40' });
    expect(await splitsOf(coles)).toEqual(after2);

    // 删除 Cosmetics 那行 → 主拆分回到 -4340，只剩 Household supplies
    expect(await removeSplit(t.ctx, r2.splitId)).toMatchObject({ ok: true });
    expect(brief(await splitsOf(coles))).toEqual([
      ['主', -4340, 'Groceries / Supermarket', 'Home (category)'],
      ['', -1500, SUPPLIES, 'Home (category)'],
    ]);
  });

  // ---------- 拆出 ----------

  it('R15.2: chosen member → manual; note is saved; positive transaction keeps its sign', async () => {
    await importJoint();
    const medicare = await txIdByMerchant('MEDICARE BENEFIT'); // +4580
    const r = await addSplit(t.ctx, medicare, {
      amountCents: 1000,
      categoryId: t.h.category(COSMETICS).id,
      memberId: t.h.member('Female').id,
      note: '  药店  ',
    });
    expect(r.ok).toBe(true);
    const s = await splitsOf(medicare);
    expect(s.map((x) => x.amountCents)).toEqual([3580, 1000]);
    expect(s[1]).toMatchObject({ member: 'Female', memberSource: 'manual', note: '药店' });
  });

  it('R15.2: amount must be > 0 and < primary; equal to primary is rejected', async () => {
    await importJoint();
    const coles = await txIdByMerchant('COLES 0559 MELBOURNE');
    const cat = t.h.category(SUPPLIES).id;
    for (const amountCents of [0, -100, 12.5, 5840]) {
      const r = await addSplit(t.ctx, coles, { amountCents, categoryId: cat });
      expect(r.ok).toBe(false);
    }
    expect(await getSplits(coles)).toHaveLength(1);
  });

  it('R16.2 / R16.3: auto transfers cannot be split; internal transfer category cannot be chosen', async () => {
    await importJoint();
    const transfer = await txIdByMerchant('TRANSFER TO ****0003');
    expect(
      (await addSplit(t.ctx, transfer, { amountCents: 100, categoryId: t.h.category(SUPPLIES).id }))
        .ok,
    ).toBe(false);

    const coles = await txIdByMerchant('COLES 0559 MELBOURNE');
    expect(
      (
        await addSplit(t.ctx, coles, {
          amountCents: 100,
          categoryId: t.h.systemCategory('internal_transfer').id,
        })
      ).ok,
    ).toBe(false);
    expect(await getSplits(transfer)).toHaveLength(1);
    expect(await getSplits(coles)).toHaveLength(1);
  });

  // ---------- 修改 ----------

  it('R15.3: changing a non-primary amount moves the difference to/from the primary', async () => {
    await importJoint();
    const coles = await txIdByMerchant('COLES 0559 MELBOURNE');
    const r = await addSplit(t.ctx, coles, {
      amountCents: 1500,
      categoryId: t.h.category(SUPPLIES).id,
    });
    if (!r.ok) throw new Error(r.message);

    expect(await updateSplit(t.ctx, r.splitId, { amountCents: 2000 })).toMatchObject({ ok: true });
    expect((await splitsOf(coles)).map((s) => s.amountCents)).toEqual([-3840, -2000]);

    expect(await updateSplit(t.ctx, r.splitId, { amountCents: 500 })).toMatchObject({ ok: true });
    expect((await splitsOf(coles)).map((s) => s.amountCents)).toEqual([-5340, -500]);

    // 主拆分 + 这一笔 = 58.40，等于时主拆分变 0，报错
    expect((await updateSplit(t.ctx, r.splitId, { amountCents: 5840 })).ok).toBe(false);
    expect((await splitsOf(coles)).map((s) => s.amountCents)).toEqual([-5340, -500]);
  });

  it('R15.3: the primary split can change category, member and note, but not amount', async () => {
    await importJoint();
    const coles = await txIdByMerchant('COLES 0559 MELBOURNE');
    await addSplit(t.ctx, coles, { amountCents: 1500, categoryId: t.h.category(SUPPLIES).id });
    const primary = (await splitsOf(coles))[0];

    expect((await updateSplit(t.ctx, primary.id, { amountCents: 1000 })).ok).toBe(false);

    // R16.4：改分类 → manual，R5.1 重算：Restaurants 没有分类默认 → 卡 1111 → Male
    await updateSplit(t.ctx, primary.id, {
      categoryId: t.h.category('Entertainment & eat-out / Restaurants').id,
      note: '和朋友吃饭',
    });
    expect((await splitsOf(coles))[0]).toMatchObject({
      amountCents: -4340,
      category: 'Entertainment & eat-out / Restaurants',
      categorySource: 'manual',
      member: 'Male',
      memberSource: 'card',
      note: '和朋友吃饭',
    });

    await updateSplit(t.ctx, primary.id, { memberId: t.h.member('Home').id, note: '' });
    expect((await splitsOf(coles))[0]).toMatchObject({
      member: 'Home',
      memberSource: 'manual',
      note: null,
    });
  });

  it('updateSplit: amount + category + member together, in one write', async () => {
    await importJoint();
    const coles = await txIdByMerchant('COLES 0559 MELBOURNE');
    const r = await addSplit(t.ctx, coles, {
      amountCents: 1500,
      categoryId: t.h.category(SUPPLIES).id,
    });
    if (!r.ok) throw new Error(r.message);

    await updateSplit(t.ctx, r.splitId, {
      amountCents: 800,
      categoryId: t.h.category(COSMETICS).id,
      memberId: t.h.member('Female').id,
    });
    expect(brief(await splitsOf(coles))).toEqual([
      ['主', -5040, 'Groceries / Supermarket', 'Home (category)'],
      ['', -800, COSMETICS, 'Female (manual)'],
    ]);
  });

  it('updateSplit: a failing part (bad category) changes nothing, not even the amount', async () => {
    await importJoint();
    const coles = await txIdByMerchant('COLES 0559 MELBOURNE');
    const r = await addSplit(t.ctx, coles, {
      amountCents: 1500,
      categoryId: t.h.category(SUPPLIES).id,
    });
    if (!r.ok) throw new Error(r.message);
    const before = await splitsOf(coles);

    const bad = await updateSplit(t.ctx, r.splitId, {
      amountCents: 800,
      categoryId: t.h.systemCategory('internal_transfer').id,
    });
    expect(bad.ok).toBe(false);
    expect(await splitsOf(coles)).toEqual(before);
  });

  // ---------- 删除 ----------

  it('R15.3: the primary split cannot be removed', async () => {
    await importJoint();
    const coles = await txIdByMerchant('COLES 0559 MELBOURNE');
    await addSplit(t.ctx, coles, { amountCents: 1500, categoryId: t.h.category(SUPPLIES).id });
    const before = await splitsOf(coles);
    expect((await removeSplit(t.ctx, before[0].id)).ok).toBe(false);
    expect(await splitsOf(coles)).toEqual(before);
  });

  it('R15.3: removing the last extra split makes it a normal transaction again', async () => {
    await importJoint();
    const coles = await txIdByMerchant('COLES 0559 MELBOURNE');
    const r = await addSplit(t.ctx, coles, {
      amountCents: 1500,
      categoryId: t.h.category(SUPPLIES).id,
    });
    if (!r.ok) throw new Error(r.message);
    await removeSplit(t.ctx, r.splitId);
    expect(brief(await splitsOf(coles))).toEqual([
      ['主', -5840, 'Groceries / Supermarket', 'Home (category)'],
    ]);
  });

  // ---------- household_id ----------

  it('another household cannot add, update or remove; other-household category / member rejected', async () => {
    await importJoint();
    const coles = await txIdByMerchant('COLES 0559 MELBOURNE');
    const r = await addSplit(t.ctx, coles, {
      amountCents: 1500,
      categoryId: t.h.category(SUPPLIES).id,
    });
    if (!r.ok) throw new Error(r.message);
    const before = await splitsOf(coles);

    const [other] = await db
      .insert(schema.household)
      .values({ name: 'Other Household' })
      .returning({ id: schema.household.id });
    const [otherMember] = await db
      .insert(schema.member)
      .values({ householdId: other.id, name: 'Stranger', kind: 'person' })
      .returning({ id: schema.member.id });
    const [otherCategory] = await db
      .insert(schema.category)
      .values({ householdId: other.id, nameEn: 'Stranger things', kind: 'expense' })
      .returning({ id: schema.category.id });
    const otherCtx = { ...t.ctx, householdId: other.id, memberId: null };

    expect(
      (await addSplit(otherCtx, coles, { amountCents: 100, categoryId: otherCategory.id })).ok,
    ).toBe(false);
    expect((await updateSplit(otherCtx, r.splitId, { amountCents: 100 })).ok).toBe(false);
    expect((await removeSplit(otherCtx, r.splitId)).ok).toBe(false);

    expect(
      (await addSplit(t.ctx, coles, { amountCents: 100, categoryId: otherCategory.id })).ok,
    ).toBe(false);
    expect(
      (
        await addSplit(t.ctx, coles, {
          amountCents: 100,
          categoryId: t.h.category(SUPPLIES).id,
          memberId: otherMember.id,
        })
      ).ok,
    ).toBe(false);
    expect((await updateSplit(t.ctx, r.splitId, { memberId: otherMember.id })).ok).toBe(false);

    expect(await splitsOf(coles)).toEqual(before);
  });
});
