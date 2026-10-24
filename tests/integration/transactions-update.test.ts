// M4-3 修改分类、归属人和批量修改（business-rules.md R5.1、R16.1、R16.2、R16.3、R16.4）
// 期望值来自 docs/tasks/m4.md M4-3 完成标准和 fixtures/README.md（joint、R5.1 重算、拆分用例）
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { importCsv } from '@/server/imports';
import { bulkUpdate, updateSplitCategory, updateSplitMember } from '@/server/transactions';
import { readFixture } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { getSplits } from './helpers/transactions';

// "中途抛错"用：failOnCall = n 时，第 n 次调用 changeCategory 抛错，其他时候走真的
const fault = vi.hoisted(() => ({ failOnCall: 0, calls: 0 }));
vi.mock('@/lib/rules/split-edit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/rules/split-edit')>();
  return {
    ...real,
    changeCategory: (...args: Parameters<typeof real.changeCategory>) => {
      fault.calls++;
      if (fault.failOnCall > 0 && fault.calls === fault.failOnCall) throw new Error('故意抛错');
      return real.changeCategory(...args);
    },
  };
});

let t: DbTestHousehold;

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

async function primarySplit(merchant: string) {
  const splits = await getSplits(await txIdByMerchant(merchant));
  return splits.find((s) => s.isPrimary)!;
}

// 拆分的分类、归属人，换成名字方便比较
async function describeSplit(splitId: string) {
  const [s] = await db
    .select()
    .from(schema.transactionSplit)
    .where(eq(schema.transactionSplit.id, splitId));
  const cat = t.h.categories.find((c) => c.id === s.categoryId)!;
  const parent = cat.parentId ? t.h.categories.find((c) => c.id === cat.parentId)! : null;
  return {
    category: parent ? `${parent.nameEn} / ${cat.nameEn}` : cat.nameEn,
    categorySource: s.categorySource,
    member: t.h.members.find((m) => m.id === s.memberId)!.name,
    memberSource: s.memberSource,
    isPreTax: s.isPreTax,
  };
}

// 整个家庭所有拆分的快照，用来证明"一笔都没改"
async function snapshot() {
  return db
    .select()
    .from(schema.transactionSplit)
    .where(eq(schema.transactionSplit.householdId, t.ctx.householdId))
    .orderBy(schema.transactionSplit.id);
}

// fixtures/README.md "拆分（R15）"：#19 主拆分 -3540，再加 -1500 Household supplies、-800 Cosmetics
// M4-6 才有拆分的数据层，这里直接写库。返回交易 id
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

describeDb('M4-3 updateSplitCategory / updateSplitMember / bulkUpdate', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    fault.failOnCall = 0;
    fault.calls = 0;
  });

  // ---------- 完成标准 ----------

  it('R5.1: the two recompute steps on #16 match fixtures/README', async () => {
    await importJoint();
    const s = await primarySplit('EASI AU ****2605');
    expect(await describeSplit(s.id)).toMatchObject({ member: 'Female', memberSource: 'card' });

    // 第 1 步：改成 Groceries / Supermarket → 归属人自动变成 Home（category）
    expect(
      await updateSplitCategory(t.ctx, s.id, t.h.category('Groceries / Supermarket').id),
    ).toEqual({ ok: true, changed: true });
    expect(await describeSplit(s.id)).toEqual({
      category: 'Groceries / Supermarket',
      categorySource: 'manual',
      member: 'Home',
      memberSource: 'category',
      isPreTax: false,
    });

    // 第 2 步：归属人手动改成 Female，再把分类改成 Uncategorised → 归属人保持 Female
    expect(await updateSplitMember(t.ctx, s.id, t.h.member('Female').id)).toEqual({
      ok: true,
      changed: true,
    });
    await updateSplitCategory(t.ctx, s.id, t.h.systemCategory('uncategorized').id);
    expect(await describeSplit(s.id)).toEqual({
      category: 'Uncategorised',
      categorySource: 'manual',
      member: 'Female',
      memberSource: 'manual',
      isPreTax: false,
    });
  });

  it('R16.1: bulk update 3 rows where 1 has multiple splits → 2 updated, 1 skipped', async () => {
    await importJoint();
    const colesId = await splitColes();
    const before = await getSplits(colesId);
    const restaurants = t.h.category('Entertainment & eat-out / Restaurants').id;

    const r = await bulkUpdate(
      t.ctx,
      [
        await txIdByMerchant('UNKNOWN SHOP PTY LTD MELBOURNE'),
        await txIdByMerchant('CHARGEFOX PTY LTD NORTH MELBOUR'),
        colesId,
      ],
      { categoryId: restaurants },
    );
    expect(r).toEqual({ ok: true, updatedCount: 2, skippedCount: 1 });

    for (const m of ['UNKNOWN SHOP PTY LTD MELBOURNE', 'CHARGEFOX PTY LTD NORTH MELBOUR']) {
      expect(await describeSplit((await primarySplit(m)).id)).toMatchObject({
        category: 'Entertainment & eat-out / Restaurants',
        categorySource: 'manual',
      });
    }
    expect(await getSplits(colesId)).toEqual(before);
  });

  it('R16.2: bulk category change skips an auto transfer', async () => {
    await importJoint();
    const transferId = await txIdByMerchant('TRANSFER TO ****0003');
    const before = await getSplits(transferId);

    const r = await bulkUpdate(
      t.ctx,
      [await txIdByMerchant('UNKNOWN SHOP PTY LTD MELBOURNE'), transferId],
      { categoryId: t.h.category('Groceries / Supermarket').id },
    );
    expect(r).toEqual({ ok: true, updatedCount: 1, skippedCount: 1 });
    expect(await getSplits(transferId)).toEqual(before);
    expect((await describeSplit(before[0].id)).category).toBe('Internal transfer');
  });

  it('an error midway rolls everything back: nothing changed', async () => {
    await importJoint();
    const ids = [
      await txIdByMerchant('UNKNOWN SHOP PTY LTD MELBOURNE'),
      await txIdByMerchant('CHARGEFOX PTY LTD NORTH MELBOUR'),
      await txIdByMerchant('POCHANA MELBOURNE MELBOURNE'),
    ];
    const before = await snapshot();
    fault.failOnCall = 2; // 第 1 笔已经写进去了，第 2 笔抛错

    await expect(
      bulkUpdate(t.ctx, ids, { categoryId: t.h.category('Groceries / Supermarket').id }),
    ).rejects.toThrow('故意抛错');
    expect(fault.calls).toBe(2);
    expect(await snapshot()).toEqual(before);
  });

  // ---------- 单笔修改的其他情况 ----------

  it('R16.1: a child split can be edited on its own; R5.1 uses the transaction card', async () => {
    await importJoint();
    const colesId = await splitColes();
    const child = (await getSplits(colesId)).find((s) => s.amountCents === -800)!;

    // Coffee & tea 没有分类默认 → #19 的卡 1111 → Male（card）
    await updateSplitCategory(
      t.ctx,
      child.id,
      t.h.category('Entertainment & eat-out / Coffee & tea').id,
    );
    expect(await describeSplit(child.id)).toMatchObject({
      category: 'Entertainment & eat-out / Coffee & tea',
      categorySource: 'manual',
      member: 'Male',
      memberSource: 'card',
    });
    const primary = (await getSplits(colesId)).find((s) => s.isPrimary)!;
    expect(await describeSplit(primary.id)).toMatchObject({
      category: 'Groceries / Supermarket',
      member: 'Home',
    });
  });

  it('same category: nothing written, category_source stays as it was', async () => {
    await importJoint();
    const s = await primarySplit('COLES 0559 MELBOURNE');
    expect(s.categorySource).toBe('rule');
    expect(
      await updateSplitCategory(t.ctx, s.id, t.h.category('Groceries / Supermarket').id),
    ).toEqual({ ok: true, changed: false });
    expect((await describeSplit(s.id)).categorySource).toBe('rule');
  });

  it('R16.4: is_pre_tax follows the new category default', async () => {
    await importJoint();
    const s = await primarySplit('UNKNOWN SHOP PTY LTD MELBOURNE');
    // seed 里税前默认的：Income / Contract income (B2B)、Income / Interest
    await updateSplitCategory(t.ctx, s.id, t.h.category('Income / Interest').id);
    expect((await describeSplit(s.id)).isPreTax).toBe(true);
  });

  it('R16.2: an auto transfer cannot change category but can change member', async () => {
    await importJoint();
    const s = await primarySplit('TRANSFER TO ****0003');
    const r = await updateSplitCategory(t.ctx, s.id, t.h.category('Groceries / Supermarket').id);
    expect(r.ok).toBe(false);
    expect((await describeSplit(s.id)).category).toBe('Internal transfer');

    expect(await updateSplitMember(t.ctx, s.id, t.h.member('Male').id)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await describeSplit(s.id)).toMatchObject({
      category: 'Internal transfer',
      member: 'Male',
      memberSource: 'manual',
    });
  });

  it('R16.3: internal transfer and archived categories cannot be chosen', async () => {
    await importJoint();
    const s = await primarySplit('UNKNOWN SHOP PTY LTD MELBOURNE');
    const before = await snapshot();

    const internal = t.h.systemCategory('internal_transfer').id;
    expect((await updateSplitCategory(t.ctx, s.id, internal)).ok).toBe(false);
    expect((await bulkUpdate(t.ctx, [s.transactionId], { categoryId: internal })).ok).toBe(false);

    // 一级归档后，它的二级也不能选
    const restaurants = t.h.category('Entertainment & eat-out / Restaurants');
    await db
      .update(schema.category)
      .set({ isArchived: true })
      .where(eq(schema.category.id, restaurants.parentId!));
    expect((await updateSplitCategory(t.ctx, s.id, restaurants.id)).ok).toBe(false);

    expect(await snapshot()).toEqual(before);
  });

  it('cash withdrawal and bank fee system categories can be chosen (R16.3)', async () => {
    await importJoint();
    const s = await primarySplit('UNKNOWN SHOP PTY LTD MELBOURNE');
    const r = await updateSplitCategory(t.ctx, s.id, t.h.systemCategory('bank_fee').id);
    expect(r).toEqual({ ok: true, changed: true });
  });

  // ---------- household_id ----------

  it('category, member and split from another household are rejected; nothing changes', async () => {
    await importJoint();
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

    const s = await primarySplit('UNKNOWN SHOP PTY LTD MELBOURNE');
    const before = await snapshot();

    expect((await updateSplitCategory(t.ctx, s.id, otherCategory.id)).ok).toBe(false);
    expect((await updateSplitMember(t.ctx, s.id, otherMember.id)).ok).toBe(false);
    expect((await bulkUpdate(t.ctx, [s.transactionId], { categoryId: otherCategory.id })).ok).toBe(
      false,
    );
    expect((await bulkUpdate(t.ctx, [s.transactionId], { memberId: otherMember.id })).ok).toBe(
      false,
    );

    // 另一个家庭拿着本家庭的拆分 id、交易 id 也改不了
    const otherCtx = { ...t.ctx, householdId: other.id, memberId: null };
    expect((await updateSplitMember(otherCtx, s.id, otherMember.id)).ok).toBe(false);
    expect((await bulkUpdate(otherCtx, [s.transactionId], { memberId: otherMember.id })).ok).toBe(
      false,
    );

    expect(await snapshot()).toEqual(before);
  });

  // ---------- 批量的其他情况 ----------

  it('bulk member change: includes transfers, sets member_source = manual', async () => {
    await importJoint();
    const ids = [
      await txIdByMerchant('TRANSFER TO ****0003'),
      await txIdByMerchant('COLES 0559 MELBOURNE'),
    ];
    const r = await bulkUpdate(t.ctx, ids, { memberId: t.h.member('Female').id });
    expect(r).toEqual({ ok: true, updatedCount: 2, skippedCount: 0 });
    for (const id of ids) {
      const [s] = await getSplits(id);
      expect(await describeSplit(s.id)).toMatchObject({ member: 'Female', memberSource: 'manual' });
    }
  });

  it('bulk category + member: member ends up manual, not the R5.1 result', async () => {
    await importJoint();
    const id = await txIdByMerchant('UNKNOWN SHOP PTY LTD MELBOURNE');
    await bulkUpdate(t.ctx, [id], {
      categoryId: t.h.category('Groceries / Supermarket').id, // R5.1 会给 Home
      memberId: t.h.member('Male').id,
    });
    const [s] = await getSplits(id);
    expect(await describeSplit(s.id)).toMatchObject({
      category: 'Groceries / Supermarket',
      categorySource: 'manual',
      member: 'Male',
      memberSource: 'manual',
    });
  });

  it('bulk: unknown transaction id, empty list or no field → ok: false, nothing changed', async () => {
    await importJoint();
    const id = await txIdByMerchant('UNKNOWN SHOP PTY LTD MELBOURNE');
    const before = await snapshot();
    const cat = t.h.category('Groceries / Supermarket').id;

    expect(
      (await bulkUpdate(t.ctx, [id, '00000000-0000-4000-8000-000000000000'], { categoryId: cat }))
        .ok,
    ).toBe(false);
    expect((await bulkUpdate(t.ctx, [], { categoryId: cat })).ok).toBe(false);
    expect((await bulkUpdate(t.ctx, [id], {})).ok).toBe(false);
    expect((await bulkUpdate(t.ctx, ['not-a-uuid'], { categoryId: cat })).ok).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('bulk: duplicate ids count once', async () => {
    await importJoint();
    const id = await txIdByMerchant('UNKNOWN SHOP PTY LTD MELBOURNE');
    const r = await bulkUpdate(t.ctx, [id, id], {
      categoryId: t.h.category('Groceries / Supermarket').id,
    });
    expect(r).toEqual({ ok: true, updatedCount: 1, skippedCount: 0 });
  });
});
