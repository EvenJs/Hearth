// M6-2 手动录入数据层：新建、编辑、删除（R8.1、R17.1–R17.5）、可能重复（R17.6）
// 期望值来自 business-rules.md R8、R17 和 fixtures/README.md "pending 匹配用例"（P1–P6、P10）、U6
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { importCsv, undoImport, type ImportSuccess } from '@/server/imports';
import {
  createManualTransaction,
  deleteManualTransaction,
  getQuickAddContext,
  updateManualTransaction,
  type CreateManualInput,
} from '@/server/manual';
import { getTransaction as getDetail, listTransactions as listF8 } from '@/server/transactions';
import { readFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { getSplits, getTransaction, listTransactions } from './helpers/transactions';

const TODAY = '2026-10-26';
let t: DbTestHousehold;

async function importFixture(account: string, path: FixturePath): Promise<ImportSuccess> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account(account).id,
    fileName: path,
    text: readFixture(path),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result;
}

type Entry = {
  account: string; // 账户名，或者直接给 accountId
  accountId?: string;
  date: string;
  amount: string; // 正数，元
  kind?: 'expense' | 'income';
  description?: string;
  category?: string | null; // h.category 路径，null = 未分类
  member?: string | null; // null = 自动
};

function entryInput(e: Entry): CreateManualInput {
  return {
    amount: e.amount,
    kind: e.kind ?? 'expense',
    description: e.description ?? 'Manual entry',
    accountId: e.accountId ?? t.h.account(e.account).id,
    date: e.date,
    categoryId: e.category ? t.h.category(e.category).id : null,
    categoryGuessed: false,
    memberId: e.member ? t.h.member(e.member).id : null,
  };
}

async function record(e: Entry): Promise<string> {
  const r = await createManualTransaction(t.ctx, entryInput(e), TODAY);
  if (!r.ok) throw new Error(`录入失败: ${JSON.stringify(r.errors)}`);
  return r.id;
}

// 测试家庭没有现金账户，补一个（bank = cash，默认 Home）
async function addCashAccount(): Promise<string> {
  const [row] = await db
    .insert(schema.financialAccount)
    .values({
      householdId: t.ctx.householdId,
      name: 'Cash',
      bank: 'cash',
      type: 'cash',
      defaultMemberId: t.h.member('Home').id,
    })
    .returning({ id: schema.financialAccount.id });
  return row.id;
}

// fixtures "pending 匹配用例"的 P1 到 P6，都在 ANZ Joint
async function recordP1toP6() {
  const joint = (date: string, amount: string, category: string | null, member: string) =>
    record({ account: 'ANZ Joint', date, amount, category, member });
  return {
    P1: await joint('2026-09-20', '61.20', 'Entertainment & eat-out / Coffee & tea', 'Female'),
    P2: await joint('2026-09-20', '38.75', 'Groceries / Supermarket', 'Male'),
    P3: await joint('2026-09-11', '25.00', null, 'Home'),
    P4: await joint('2026-09-12', '25.00', null, 'Home'),
    P5: await joint('2026-09-05', '10.00', null, 'Home'),
    P6: await joint('2026-09-02', '58.40', 'Groceries / Supermarket', 'Home'),
  };
}

// F8 列表里显示"可能重复"的交易 id
async function flaggedIds(): Promise<string[]> {
  const list = await listF8(t.ctx, {}, { today: TODAY, pageSize: 200 });
  return list.items
    .filter((i) => i.possibleDuplicate)
    .map((i) => i.id)
    .sort();
}

async function partnersOf(id: string): Promise<string[]> {
  const d = await getDetail(t.ctx, id);
  if (!d) throw new Error(`找不到交易 ${id}`);
  return d.possibleDuplicates.map((p) => p.id).sort();
}

const snapshot = async (id: string) => ({
  tx: await getTransaction(id),
  splits: await getSplits(id),
});

describeDb('manual entry data layer (M6-2)', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  // ---------- R8 P1–P6 ----------

  it('R8.2/R8.3: P1 to P6 recorded with createManualTransaction, import joint → 17 inserted, 2 matched', async () => {
    const { P1, P2, P3, P4, P5, P6 } = await recordP1toP6();
    for (const id of [P1, P2, P3, P4, P5, P6]) {
      expect(await getTransaction(id), id).toMatchObject({
        status: 'pending',
        source: 'manual',
        dedupeKey: null,
        importBatchId: null,
        createdBy: t.ctx.userId,
      });
    }

    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(result).toMatchObject({ rowCount: 19, insertedCount: 17, matchedPendingCount: 2 });

    // P1 匹配 #8（相差 2 天）：日期换成银行的，保留用户的分类和归属人
    expect(await getTransaction(P1)).toMatchObject({
      status: 'confirmed',
      source: 'manual',
      date: '2026-09-22',
      merchant: 'POCHANA MELBOURNE MELBOURNE',
      importBatchId: result.batchId,
    });
    expect((await getSplits(P1))[0]).toMatchObject({
      categoryId: t.h.category('Entertainment & eat-out / Coffee & tea').id,
      categorySource: 'manual',
      memberId: t.h.member('Female').id,
      memberSource: 'manual',
    });
    // P2 匹配 #9（相差 0 天）
    expect(await getTransaction(P2)).toMatchObject({ status: 'confirmed', date: '2026-09-20' });

    // P3 到 P6 还是 pending
    for (const id of [P3, P4, P5, P6]) {
      expect(await getTransaction(id), id).toMatchObject({
        status: 'pending',
        importBatchId: null,
      });
    }
    expect(result.warnings.possibleDuplicates).toHaveLength(1);
    expect([...result.warnings.possibleDuplicates[0].pendingIds].sort()).toEqual([P3, P4].sort());

    // 17 笔新增 + 2 笔确认 + 4 笔 pending
    expect(await listTransactions(t, 'ANZ Joint')).toHaveLength(23);
  });

  it('R12.1 U6: then undo joint → P1, P2 back to pending with the bank date, 17 inserted deleted', async () => {
    const { P1, P2 } = await recordP1toP6();
    const joint = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');

    const undone = await undoImport(t.ctx, joint.batchId);
    if (!undone.ok) throw new Error(undone.message);
    expect(undone).toMatchObject({ deletedCount: 17, restoredPendingCount: 2 });

    for (const [id, date] of [
      [P1, '2026-09-22'],
      [P2, '2026-09-20'],
    ]) {
      expect(await getTransaction(id)).toMatchObject({
        status: 'pending',
        date,
        dedupeKey: null,
        importBatchId: null,
        confirmedAt: null,
      });
    }
    const left = await listTransactions(t, 'ANZ Joint');
    expect(left).toHaveLength(6);
    expect(left.every((r) => r.status === 'pending' && r.source === 'manual')).toBe(true);
  });

  // ---------- R17.6 ----------

  it('R17.6: after import #12, P3 and P4 are possible duplicates; delete P4 → #12, P3 stay; delete P3 → none', async () => {
    const { P1, P3, P4 } = await recordP1toP6();
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const n12 = (await listTransactions(t, 'ANZ Joint')).find(
      (r) => r.source === 'csv' && r.amountCents === -2500,
    )!.id;

    expect(await flaggedIds()).toEqual([n12, P3, P4].sort());
    expect(await partnersOf(n12)).toEqual([P3, P4].sort());
    expect(await partnersOf(P3)).toEqual([n12, P4].sort());
    expect(await partnersOf(P1)).toEqual([]);
    expect((await getDetail(t.ctx, P1))!.possibleDuplicate).toBe(false);

    expect(await deleteManualTransaction(t.ctx, P4)).toEqual({ ok: true });
    expect(await flaggedIds()).toEqual([n12, P3].sort());
    expect(await partnersOf(n12)).toEqual([P3]);
    expect(await partnersOf(P3)).toEqual([n12]);

    expect(await deleteManualTransaction(t.ctx, P3)).toEqual({ ok: true });
    expect(await flaggedIds()).toEqual([]);
    expect(await partnersOf(n12)).toEqual([]);
  });

  it('R17.6: undoing the import clears the possible-duplicate flags', async () => {
    await recordP1toP6();
    const joint = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(await flaggedIds()).toHaveLength(3);
    await undoImport(t.ctx, joint.batchId);
    expect(await flaggedIds()).toEqual([]);
  });

  // ---------- P10 ----------

  it('P10 / R8.3 exception: recorded with Restaurants + Female, import joint → auto + Internal transfer, Female (manual), note kept', async () => {
    const p10 = await record({
      account: 'ANZ Joint',
      date: '2026-09-14',
      amount: '500.00',
      description: 'For wife',
      category: 'Entertainment & eat-out / Restaurants',
      member: 'Female',
    });
    // 录入时不能写备注（R17.1），这里直接写库，代替以后详情页的备注编辑
    await db
      .update(schema.transaction)
      .set({ note: '给老婆' })
      .where(eq(schema.transaction.id, p10));

    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(result).toMatchObject({ rowCount: 19, insertedCount: 18, matchedPendingCount: 1 });

    expect(await getTransaction(p10)).toMatchObject({
      status: 'confirmed',
      source: 'manual',
      date: '2026-09-15',
      merchant: 'TRANSFER TO ****0003',
      transferStatus: 'auto',
      note: '给老婆',
    });
    const internal = t.h.systemCategory('internal_transfer');
    expect(
      (await getSplits(p10)).map((s) => [
        s.amountCents,
        s.categoryId,
        s.categorySource,
        s.memberId,
        s.memberSource,
      ]),
    ).toEqual([[-50000, internal.id, 'system', t.h.member('Female').id, 'manual']]);
  });

  // ---------- R17.5 ----------

  it('R17.5: P1 confirmed by the import cannot be updated or deleted, nothing changes', async () => {
    const { P1 } = await recordP1toP6();
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const before = await snapshot(P1);

    expect((await updateManualTransaction(t.ctx, P1, { amount: '70' }, TODAY)).ok).toBe(false);
    expect((await updateManualTransaction(t.ctx, P1, { date: '2026-09-21' }, TODAY)).ok).toBe(
      false,
    );
    expect((await deleteManualTransaction(t.ctx, P1)).ok).toBe(false);
    expect(await snapshot(P1)).toEqual(before);
  });

  it('R17.5: imported transactions cannot be updated or deleted', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const [row] = await listTransactions(t, 'ANZ Joint');
    expect((await updateManualTransaction(t.ctx, row.id, { date: '2026-09-01' }, TODAY)).ok).toBe(
      false,
    );
    expect((await deleteManualTransaction(t.ctx, row.id)).ok).toBe(false);
  });

  it('R17.5: a manual transaction with transfer_pair_id cannot be deleted', async () => {
    const a = await record({ account: 'ANZ Joint', date: '2026-10-01', amount: '20' });
    const b = await record({
      account: 'ANZ Male',
      date: '2026-10-01',
      amount: '20',
      kind: 'income',
    });
    await db
      .update(schema.transaction)
      .set({ transferStatus: 'suggested', transferPairId: b })
      .where(eq(schema.transaction.id, a));
    const r = await deleteManualTransaction(t.ctx, a);
    expect(r.ok).toBe(false);
    expect(await getTransaction(a)).toBeDefined();
  });

  it('R17.5: edit cash → ANZ Joint becomes pending; amount follows on the primary split', async () => {
    const cash = await addCashAccount();
    const id = await record({
      account: '',
      accountId: cash,
      date: '2026-10-20',
      amount: '12.50',
      description: 'Coffee Lab',
      category: 'Entertainment & eat-out / Coffee & tea',
    });
    expect(await getTransaction(id)).toMatchObject({ status: 'confirmed', amountCents: -1250 });

    const r = await updateManualTransaction(
      t.ctx,
      id,
      { accountId: t.h.account('ANZ Male').id, amount: '20', description: ' coffee lab ' },
      TODAY,
    );
    expect(r).toEqual({ ok: true, changed: true });
    expect(await getTransaction(id)).toMatchObject({
      accountId: t.h.account('ANZ Male').id,
      status: 'pending',
      amountCents: -2000,
      rawDescription: 'coffee lab',
      merchant: 'COFFEE LAB',
    });
    // Coffee & tea 没有分类默认 → 归属人跟着新账户变 Male（account）
    expect((await getSplits(id))[0]).toMatchObject({
      amountCents: -2000,
      memberId: t.h.member('Male').id,
      memberSource: 'account',
      categorySource: 'manual',
    });
  });

  it('R17.5: two splits → amount change rejected, nothing written', async () => {
    const id = await record({
      account: 'ANZ Joint',
      date: '2026-10-20',
      amount: '30',
      category: 'Groceries / Supermarket',
    });
    const [primary] = await getSplits(id);
    await db
      .update(schema.transactionSplit)
      .set({ amountCents: -2000 })
      .where(eq(schema.transactionSplit.id, primary.id));
    await db.insert(schema.transactionSplit).values({
      householdId: t.ctx.householdId,
      transactionId: id,
      amountCents: -1000,
      categoryId: t.h.category('Groceries / Supermarket').id,
      memberId: t.h.member('Home').id,
      categorySource: 'manual',
      memberSource: 'category',
    });
    const before = await snapshot(id);

    const r = await updateManualTransaction(t.ctx, id, { amount: '40', date: '2026-10-19' }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.amount).toBeDefined();
    expect(await snapshot(id)).toEqual(before);
  });

  it('R17.5: delete removes the transaction and its splits', async () => {
    const id = await record({ account: 'ANZ Joint', date: '2026-10-20', amount: '5' });
    expect(await deleteManualTransaction(t.ctx, id)).toEqual({ ok: true });
    expect(await getTransaction(id)).toBeUndefined();
    expect(await getSplits(id)).toEqual([]);
  });

  // ---------- R8.1、R17.1、R17.3 ----------

  it('R8.1 P7: ANZ Plus Male +8.50 Income / Interest → pending, is_pre_tax, Male (account)', async () => {
    const id = await record({
      account: 'ANZ Plus Male',
      date: '2026-09-30',
      amount: '8.50',
      kind: 'income',
      description: 'Interest',
      category: 'Income / Interest',
    });
    expect(await getTransaction(id)).toMatchObject({
      status: 'pending',
      amountCents: 850,
      cardLast4: null,
      balanceCents: null,
      dedupeKey: null,
      transferStatus: 'none',
    });
    expect(await getSplits(id)).toMatchObject([
      {
        isPrimary: true,
        amountCents: 850,
        isPreTax: true,
        memberId: t.h.member('Male').id,
        memberSource: 'account',
      },
    ]);
  });

  it('R17.1: field errors come back and nothing is written', async () => {
    const r = await createManualTransaction(
      t.ctx,
      entryInput({ account: 'ANZ Joint', date: '2026-10-27', amount: '0', description: ' ' }),
      TODAY,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['amount', 'date', 'description']);
    expect(await listTransactions(t, 'ANZ Joint')).toEqual([]);
  });

  it('R17.3: Joint + guessed Groceries / Supermarket + member auto → rule, Home (category)', async () => {
    const r = await createManualTransaction(
      t.ctx,
      {
        ...entryInput({
          account: 'ANZ Joint',
          date: '2026-10-20',
          amount: '30',
          description: 'coles',
        }),
        categoryId: t.h.category('Groceries / Supermarket').id,
        categoryGuessed: true,
      },
      TODAY,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect((await getSplits(r.id))[0]).toMatchObject({
      categorySource: 'rule',
      memberId: t.h.member('Home').id,
      memberSource: 'category',
    });
  });

  // ---------- R17.2 ----------

  it('R17.2: quick-add context has the last account and frequent categories', async () => {
    const cash = await addCashAccount();
    const coffee = 'Entertainment & eat-out / Coffee & tea';
    const lunches = 'Entertainment & eat-out / Lunches';
    await record({ account: 'ANZ Joint', date: '2026-10-20', amount: '5', category: lunches });
    await record({ account: 'ANZ Joint', date: '2026-10-21', amount: '5', category: coffee });
    await record({ account: 'ANZ Joint', date: '2026-10-22', amount: '5', category: coffee });
    // 91 天前的不算
    await record({ account: 'ANZ Joint', date: '2026-07-27', amount: '5', category: lunches });
    await record({ account: 'ANZ Joint', date: '2026-07-27', amount: '5', category: lunches });
    await record({
      account: 'ANZ Plus Male',
      date: '2026-09-30',
      amount: '8.50',
      kind: 'income',
      category: 'Income / Interest',
    });
    await record({ account: '', accountId: cash, date: '2026-10-25', amount: '3' });

    const q = await getQuickAddContext(t.ctx, TODAY);
    expect(q.lastAccountId).toBe(cash);
    expect(q.frequent).toEqual({
      expense: [t.h.category(coffee).id, t.h.category(lunches).id],
      income: [t.h.category('Income / Interest').id],
    });
    expect(q.accounts.map((a) => a.name)).toContain('Cash');
    expect(q.members.map((m) => m.name)).toContain('Home');

    // 上次的账户归档了 → 不预选
    await db
      .update(schema.financialAccount)
      .set({ isArchived: true })
      .where(eq(schema.financialAccount.id, cash));
    const q2 = await getQuickAddContext(t.ctx, TODAY);
    expect(q2.lastAccountId).toBeNull();
    expect(q2.accounts.map((a) => a.name)).not.toContain('Cash');
  });

  it('R17.2: nothing recorded yet → no last account, no frequent categories', async () => {
    const q = await getQuickAddContext(t.ctx, TODAY);
    expect(q.lastAccountId).toBeNull();
    expect(q.frequent).toEqual({ expense: [], income: [] });
  });

  // ---------- household_id ----------

  it('another household cannot create on, update or delete this household’s data', async () => {
    const id = await record({ account: 'ANZ Joint', date: '2026-10-20', amount: '12' });
    const before = await snapshot(id);

    const [other] = await db
      .insert(schema.household)
      .values({ name: 'Other Household' })
      .returning({ id: schema.household.id });
    const [otherCategory] = await db
      .insert(schema.category)
      .values({ householdId: other.id, nameEn: 'Stranger things', kind: 'expense' })
      .returning({ id: schema.category.id });
    const otherCtx = { ...t.ctx, householdId: other.id, memberId: null };

    // 别人用本家庭的账户录入
    const created = await createManualTransaction(
      otherCtx,
      entryInput({ account: 'ANZ Joint', date: '2026-10-20', amount: '1' }),
      TODAY,
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.errors.accountId).toBeDefined();

    // 本家庭用别人的分类录入
    const withOtherCategory = await createManualTransaction(
      t.ctx,
      {
        ...entryInput({ account: 'ANZ Joint', date: '2026-10-20', amount: '1' }),
        categoryId: otherCategory.id,
      },
      TODAY,
    );
    expect(withOtherCategory.ok).toBe(false);

    expect((await updateManualTransaction(otherCtx, id, { amount: '99' }, TODAY)).ok).toBe(false);
    expect((await deleteManualTransaction(otherCtx, id)).ok).toBe(false);
    expect(await snapshot(id)).toEqual(before);
    expect(await listTransactions(t, 'ANZ Joint')).toHaveLength(1);
  });

  it('bad ids → not found, no throw', async () => {
    expect((await updateManualTransaction(t.ctx, 'nope', { amount: '1' }, TODAY)).ok).toBe(false);
    expect((await deleteManualTransaction(t.ctx, 'nope')).ok).toBe(false);
  });
});
