// M9-3 账户余额的数据层（business-rules.md R23）
// 期望值来自 fixtures/cases/14-balance.md。锚点和交易按用例直接插表，今天 = 2026-12-10
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { AccountValues } from '@/lib/accounts/account-input';
import { openingAnchorDate } from '@/lib/rules/balance';
import { addDays } from '@/lib/rules/periods';
import { createAccount, setAccountArchived, updateAccount } from '@/server/accounts';
import { addManualBalance, deleteManualBalance, getAccountBalances } from '@/server/balances';
import { undoImport } from '@/server/imports';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

let t: DbTestHousehold;

const TODAY = '2026-12-10';
const at = (date: string) => new Date(`${date}T00:00:00Z`);

// ---------- 插数据 ----------

async function batch(
  account: string,
  source: 'csv' | 'pdf',
  dateFrom: string,
  dateTo: string,
  closingBalanceCents: number | null,
  createdAt: string,
): Promise<string> {
  const [row] = await db
    .insert(schema.importBatch)
    .values({
      householdId: t.ctx.householdId,
      accountId: t.h.account(account).id,
      fileName: `${account} ${dateTo}.${source}`,
      source,
      dateFrom,
      dateTo,
      rowCount: 0,
      insertedCount: 0,
      duplicateCount: 0,
      matchedPendingCount: 0,
      closingBalanceCents,
      createdBy: t.ctx.userId,
      createdAt: at(createdAt),
    })
    .returning({ id: schema.importBatch.id });
  return row.id;
}

type TxRow = {
  date: string;
  amountCents: number;
  pending?: boolean;
  batchId?: string;
  // 拆分：[金额, 分类路径]，第一个是主拆分。不传 = 一个 Uncategorised 拆分
  splits?: [number, string][];
};

async function tx(accountId: string, r: TxRow): Promise<string> {
  const account = t.h.accounts.find((a) => a.id === accountId);
  const memberId = account?.defaultMemberId ?? t.h.member('Male').id;
  const [row] = await db
    .insert(schema.transaction)
    .values({
      householdId: t.ctx.householdId,
      accountId,
      date: r.date,
      amountCents: r.amountCents,
      rawDescription: 'TEST',
      merchant: 'TEST',
      status: r.pending ? 'pending' : 'confirmed',
      source: r.pending ? 'manual' : 'csv',
      importBatchId: r.batchId ?? null,
      createdBy: t.ctx.userId,
    })
    .returning({ id: schema.transaction.id });
  const splits: [number, string][] = r.splits ?? [[r.amountCents, '']];
  await db.insert(schema.transactionSplit).values(
    splits.map(([amountCents, path], i) => ({
      householdId: t.ctx.householdId,
      transactionId: row.id,
      amountCents,
      categoryId: path ? t.h.category(path).id : t.h.systemCategory('uncategorized').id,
      memberId,
      categorySource: 'manual',
      memberSource: 'manual',
      isPrimary: i === 0,
    })),
  );
  return row.id;
}

async function txs(account: string, rows: TxRow[]) {
  for (const r of rows) await tx(t.h.account(account).id, r);
}

async function manual(account: string, date: string, balanceCents: number, createdAt: string) {
  await db.insert(schema.accountBalance).values({
    householdId: t.ctx.householdId,
    accountId: t.h.account(account).id,
    date,
    balanceCents,
    createdBy: t.ctx.userId,
    createdAt: at(createdAt),
  });
}

async function balanceOf(accountId: string) {
  const row = (await getAccountBalances(t.ctx, TODAY)).find((a) => a.id === accountId);
  if (!row) throw new Error(`getAccountBalances 里没有 ${accountId}`);
  return row;
}
const balanceByName = (name: string) => balanceOf(t.h.account(name).id);

function valuesOf(name: string, overrides: Partial<AccountValues> = {}): AccountValues {
  const a = t.h.account(name);
  return {
    name: a.name,
    bank: a.bank,
    type: a.type,
    defaultMemberId: a.defaultMemberId,
    numberSuffix: a.numberSuffix,
    ...overrides,
  };
}

async function accountRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.financialAccount)
    .where(eq(schema.financialAccount.id, id));
  return row;
}

async function anchorsOf(accountId: string) {
  return db
    .select()
    .from(schema.accountBalance)
    .where(eq(schema.accountBalance.accountId, accountId));
}

// 现金（Female）：用 createAccount 建，开户余额 8550
async function createCashFemale(): Promise<string> {
  await createAccount(t.ctx, {
    name: '现金（Female）',
    bank: 'cash',
    type: 'cash',
    defaultMemberId: t.h.member('Female').id,
    numberSuffix: null,
    openingBalanceCents: 8550,
  });
  const [row] = await db
    .select({ id: schema.financialAccount.id })
    .from(schema.financialAccount)
    .where(
      and(
        eq(schema.financialAccount.householdId, t.ctx.householdId),
        eq(schema.financialAccount.name, '现金（Female）'),
      ),
    );
  return row.id;
}

// 别的家庭：一个归属人、一个账户 Other ANZ（场景 L）
async function otherHouseholdAccount(): Promise<{ householdId: string; accountId: string }> {
  const [hh] = await db
    .insert(schema.household)
    .values({ name: 'Other Household' })
    .returning({ id: schema.household.id });
  const [m] = await db
    .insert(schema.member)
    .values({ householdId: hh.id, name: 'Someone', kind: 'person' })
    .returning({ id: schema.member.id });
  const [a] = await db
    .insert(schema.financialAccount)
    .values({
      householdId: hh.id,
      name: 'Other ANZ',
      bank: 'anz',
      type: 'everyday',
      defaultMemberId: m.id,
      numberSuffix: '0009',
    })
    .returning({ id: schema.financialAccount.id });
  return { householdId: hh.id, accountId: a.id };
}

// ANZ Old：已归档，有手动锚点 2026-09-30 = 100000
async function createAnzOld(): Promise<string> {
  const [a] = await db
    .insert(schema.financialAccount)
    .values({
      householdId: t.ctx.householdId,
      name: 'ANZ Old',
      bank: 'anz',
      type: 'everyday',
      defaultMemberId: t.h.member('Male').id,
      numberSuffix: '0008',
      isArchived: true,
    })
    .returning({ id: schema.financialAccount.id });
  await db.insert(schema.accountBalance).values({
    householdId: t.ctx.householdId,
    accountId: a.id,
    date: '2026-09-30',
    balanceCents: 100000,
    createdBy: t.ctx.userId,
  });
  return a.id;
}

describeDb('M9-3 getAccountBalances / addManualBalance / deleteManualBalance（R23）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  // ---------- 场景 A ----------

  async function scenarioA() {
    await batch('ANZ Joint', 'pdf', '2026-09-05', '2026-10-04', 480000, '2026-10-06');
    const pdf1 = await batch('ANZ Joint', 'pdf', '2026-10-05', '2026-11-04', 523450, '2026-11-06');
    const c1 = await batch('ANZ Joint', 'csv', '2026-10-28', '2026-12-07', 999999, '2026-12-08');
    await txs('ANZ Joint', [
      { date: '2026-10-10', amountCents: -15000, batchId: pdf1 },
      { date: '2026-10-18', amountCents: 30000, batchId: pdf1 },
      { date: '2026-10-25', amountCents: 34150, batchId: pdf1 },
      { date: '2026-11-02', amountCents: -700, pending: true },
      { date: '2026-11-03', amountCents: -4500, batchId: pdf1 },
      { date: '2026-11-04', amountCents: -1200, batchId: pdf1 },
      { date: '2026-11-05', amountCents: -6550, batchId: c1 },
      { date: '2026-11-20', amountCents: 250000, batchId: c1 },
      { date: '2026-12-01', amountCents: -200000, batchId: c1 },
      { date: '2026-12-07', amountCents: -3210, batchId: c1 },
      { date: '2026-12-08', amountCents: -4599, pending: true },
      { date: '2026-12-09', amountCents: -1250, pending: true },
    ]);
  }

  const A1_BALANCE = {
    postedCents: 563690,
    availableCents: 557841,
    pendingCount: 2,
    pendingCents: -5849,
    asOf: '2026-12-09',
  };

  it('R23 A-1: latest PDF is the anchor, CSV closing is ignored, anchor-day and older pending not counted', async () => {
    await scenarioA();
    expect(await balanceByName('ANZ Joint')).toMatchObject({
      balance: A1_BALANCE,
      anchorSource: 'pdf',
      lastCalibrationDiffCents: null,
      interestCents: 0,
    });
  });

  it('R23 A-4: manual balance earlier than the PDF compares with PDF0, current balance unchanged', async () => {
    await scenarioA();
    const result = await addManualBalance(
      t.ctx,
      { accountId: t.h.account('ANZ Joint').id, date: '2026-10-20', balanceCents: 500000 },
      TODAY,
    );
    expect(result).toMatchObject({ ok: true, diffCents: 5000 });
    expect(await balanceByName('ANZ Joint')).toMatchObject({
      balance: A1_BALANCE,
      anchorSource: 'pdf',
      lastCalibrationDiffCents: 5000,
    });
  });

  // ---------- 场景 B、I ----------

  async function scenarioB() {
    const pdf1 = await batch('ANZ Plus Male', 'pdf', '2026-10-01', '2026-10-31', 1072500, '2026-11-03');
    const pdf2 = await batch('ANZ Plus Male', 'pdf', '2026-11-01', '2026-11-30', 1079700, '2026-12-03');
    const interest = (date: string, amountCents: number, batchId?: string): TxRow => ({
      date,
      amountCents,
      batchId,
      splits: [[amountCents, 'Income / Interest']],
    });
    await txs('ANZ Plus Male', [
      interest('2026-06-30', 2100),
      interest('2026-07-01', 2200),
      interest('2026-08-31', 2300),
      interest('2026-09-30', 2350),
      interest('2026-10-31', 2400, pdf1),
      { date: '2026-11-02', amountCents: 5000, batchId: pdf2 },
      interest('2026-11-12', -300, pdf2),
      interest('2026-11-30', 2500, pdf2),
    ]);
    return pdf2;
  }

  it('R23 B-1 / I: only PDF, anchor-day transaction not counted; interest this FY', async () => {
    await scenarioB();
    expect(await balanceByName('ANZ Plus Male')).toMatchObject({
      balance: {
        postedCents: 1079700,
        availableCents: 1079700,
        pendingCount: 0,
        pendingCents: 0,
        asOf: '2026-11-30',
      },
      anchorSource: 'pdf',
      interestCents: 11450,
    });
  });

  it('R23 B-2: undo the latest PDF → falls back to the previous PDF anchor (R12.1)', async () => {
    const pdf2 = await scenarioB();
    expect(await undoImport(t.ctx, pdf2)).toMatchObject({ ok: true, deletedCount: 3 });
    expect(await balanceByName('ANZ Plus Male')).toMatchObject({
      balance: { postedCents: 1072500, availableCents: 1072500, asOf: '2026-10-31' },
      anchorSource: 'pdf',
      interestCents: 9250,
    });
  });

  // ---------- 场景 D ----------

  it('R23 D-1 / D-2: same-day PDF beats manual, CBA CSV is not an anchor; manual diff vs same-day PDF', async () => {
    const pdfC = await batch('CBA Female', 'pdf', '2026-11-02', '2026-12-01', 812345, '2026-12-03');
    await manual('CBA Female', '2026-12-01', 812000, '2026-12-05');
    const csvC = await batch('CBA Female', 'csv', '2026-12-02', '2026-12-08', 850100, '2026-12-09');
    await txs('CBA Female', [
      { date: '2026-12-01', amountCents: -2000, batchId: pdfC },
      { date: '2026-12-04', amountCents: -12345, batchId: csvC },
      {
        date: '2026-12-08',
        amountCents: 50000,
        batchId: csvC,
        splits: [
          [49800, 'Income / Salary'],
          [200, 'Income / Interest'],
        ],
      },
    ]);
    expect(await balanceByName('CBA Female')).toMatchObject({
      balance: { postedCents: 850000, availableCents: 850000, asOf: '2026-12-08' },
      anchorSource: 'pdf',
      lastCalibrationDiffCents: -345,
      interestCents: 200,
    });
  });

  // ---------- 场景 E ----------

  it('R23 E-1 to E-5: manual calibration diffs, backfill clears the diff, delete falls back', async () => {
    const id = t.h.account('ANZ Male').id;
    await txs('ANZ Male', [
      { date: '2026-11-30', amountCents: -1500 },
      { date: '2026-12-02', amountCents: -2350 },
      { date: '2026-12-04', amountCents: 120000 },
      { date: '2026-12-05', amountCents: -999, pending: true },
      { date: '2026-12-06', amountCents: -18000 },
      { date: '2026-12-08', amountCents: -5250 },
      { date: '2026-12-10', amountCents: -1800, pending: true },
    ]);
    expect(await balanceOf(id)).toMatchObject({ balance: null, anchorSource: null });

    const add = (date: string, balanceCents: number) =>
      addManualBalance(t.ctx, { accountId: id, date, balanceCents }, TODAY);
    expect(await add('2026-11-30', 345600)).toMatchObject({ ok: true, diffCents: null }); // E-1
    expect(await add('2026-12-06', 445250)).toMatchObject({ ok: true, diffCents: 0 }); // E-2
    const m3 = await add('2026-12-09', 437000); // E-3
    expect(m3).toMatchObject({ ok: true, diffCents: -3000 });

    const e3 = {
      balance: {
        postedCents: 437000,
        availableCents: 435200,
        pendingCount: 1,
        pendingCents: -1800,
        asOf: '2026-12-10',
      },
      anchorSource: 'manual',
    };
    expect(await balanceOf(id)).toMatchObject({ ...e3, lastCalibrationDiffCents: -3000 });
    // 弹窗里的手动余额列表：日期新的在前
    expect((await balanceOf(id)).manualBalances.map((m) => [m.date, m.balanceCents])).toEqual([
      ['2026-12-09', 437000],
      ['2026-12-06', 445250],
      ['2026-11-30', 345600],
    ]);

    // E-4：补导 e8，差额实时算，跟着消失
    await txs('ANZ Male', [{ date: '2026-12-07', amountCents: -3000 }]);
    expect(await balanceOf(id)).toMatchObject({ ...e3, lastCalibrationDiffCents: 0 });

    // E-5：删掉 M3，退回 M2
    if (!m3.ok) throw new Error('M3 没存上');
    expect(await deleteManualBalance(t.ctx, m3.id)).toEqual({ ok: true });
    expect(await balanceOf(id)).toMatchObject({ ...e3, lastCalibrationDiffCents: 0 });
    expect(await anchorsOf(id)).toHaveLength(2);
  });

  // ---------- 场景 F、G ----------

  it('R23 F-2 / G-3: new cash account writes an opening anchor the day before; deleting it leaves no balance', async () => {
    const id = await createCashFemale();
    const row = await accountRow(id);
    const anchorDate = openingAnchorDate(row.createdAt);
    const anchors = await anchorsOf(id);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ date: anchorDate, balanceCents: 8550, createdBy: t.ctx.userId });
    expect(row.purpose).toBe('everyday');

    await tx(id, { date: addDays(anchorDate, 1), amountCents: -1200 });
    await tx(id, { date: addDays(anchorDate, 5), amountCents: -650 });
    expect(await balanceOf(id)).toMatchObject({
      balance: { postedCents: 6700, availableCents: 6700, asOf: addDays(anchorDate, 5) },
      anchorSource: 'manual',
      lastCalibrationDiffCents: null,
    });

    expect(await deleteManualBalance(t.ctx, anchors[0].id)).toEqual({ ok: true });
    expect(await balanceOf(id)).toMatchObject({ balance: null, anchorSource: null });
  });

  it('R23 F-1 / F-3: opening balance defaults to 0; credit card negative opening balance', async () => {
    await createAccount(t.ctx, {
      name: 'Westpac 中转',
      bank: 'other',
      type: 'everyday',
      defaultMemberId: t.h.member('Home').id,
      numberSuffix: '0005',
    });
    await createAccount(t.ctx, {
      name: 'ANZ Card',
      bank: 'anz',
      type: 'credit_card',
      defaultMemberId: t.h.member('Male').id,
      numberSuffix: '0006',
      openingBalanceCents: -45000,
    });
    const all = await getAccountBalances(t.ctx, TODAY);
    const westpac = all.find((a) => a.name === 'Westpac 中转')!;
    const card = all.find((a) => a.name === 'ANZ Card')!;
    const westpacDate = westpac.balance!.asOf; // 开户锚点日期
    const cardDate = card.balance!.asOf;
    expect(westpac.balance).toMatchObject({ postedCents: 0, availableCents: 0 });

    await tx(westpac.id, { date: addDays(westpacDate, 1), amountCents: 200000 });
    await tx(card.id, { date: addDays(cardDate, 1), amountCents: -3000 });
    await tx(card.id, { date: addDays(cardDate, 14), amountCents: -12000 });
    await tx(card.id, { date: addDays(cardDate, 18), amountCents: 45000 });
    expect((await balanceOf(westpac.id)).balance).toMatchObject({
      postedCents: 200000,
      asOf: addDays(westpacDate, 1),
    });
    expect((await balanceOf(card.id)).balance).toMatchObject({
      postedCents: -15000,
      availableCents: -15000,
      asOf: addDays(cardDate, 18),
    });
  });

  it('R23 G-1: existing account without anchor has no balance, transactions are not summed from 0', async () => {
    await txs('ANZ Joint', [{ date: '2026-11-10', amountCents: -2000 }]);
    expect(await balanceByName('ANZ Joint')).toMatchObject({
      balance: null,
      anchorSource: null,
      lastCalibrationDiffCents: null,
      interestCents: 0,
    });
  });

  // ---------- 场景 H ----------

  it('R23 H: pending interest goes into available balance and interest; first manual has no diff', async () => {
    await manual('CBA Female Saver', '2026-11-30', 1500000, '2026-12-01');
    await txs('CBA Female Saver', [
      { date: '2026-11-30', amountCents: 900, splits: [[900, 'Income / Interest']] },
      { date: '2026-12-10', amountCents: 120, pending: true, splits: [[120, 'Income / Interest']] },
    ]);
    expect(await balanceByName('CBA Female Saver')).toMatchObject({
      balance: {
        postedCents: 1500000,
        availableCents: 1500120,
        pendingCount: 1,
        pendingCents: 120,
        asOf: '2026-12-10',
      },
      anchorSource: 'manual',
      lastCalibrationDiffCents: null,
      interestCents: 1020,
    });
  });

  // ---------- 归档、校验、家庭隔离 ----------

  it('R23.2: archived accounts are not returned and cannot get a manual balance', async () => {
    const old = await createAnzOld();
    expect((await getAccountBalances(t.ctx, TODAY)).map((a) => a.id)).not.toContain(old);
    expect(
      await addManualBalance(t.ctx, { accountId: old, date: '2026-12-09', balanceCents: 1 }, TODAY),
    ).toEqual({ ok: false, errors: { accountId: '已归档的账户不能填余额' } });
  });

  it('R23.3: date later than today and malformed input are rejected, nothing is written', async () => {
    const id = t.h.account('ANZ Male').id;
    expect(
      await addManualBalance(t.ctx, { accountId: id, date: '2026-12-11', balanceCents: 1 }, TODAY),
    ).toEqual({ ok: false, errors: { date: '日期不能晚于今天' } });
    expect(
      await addManualBalance(t.ctx, { accountId: id, date: '2026-12-01', balanceCents: 1.5 }, TODAY),
    ).toMatchObject({ ok: false, errors: { balanceCents: expect.any(String) } });
    expect(await anchorsOf(id)).toHaveLength(0);
  });

  it("R23.3: another household's account cannot get a manual balance, its anchors cannot be deleted", async () => {
    const other = await otherHouseholdAccount();
    expect(
      await addManualBalance(
        t.ctx,
        { accountId: other.accountId, date: '2026-12-09', balanceCents: 1 },
        TODAY,
      ),
    ).toEqual({ ok: false, errors: { accountId: '找不到这个账户' } });
    expect(await anchorsOf(other.accountId)).toHaveLength(0);

    const [theirs] = await db
      .insert(schema.accountBalance)
      .values({
        householdId: other.householdId,
        accountId: other.accountId,
        date: '2026-12-01',
        balanceCents: 1,
        createdBy: t.ctx.userId,
      })
      .returning({ id: schema.accountBalance.id });
    expect(await deleteManualBalance(t.ctx, theirs.id)).toEqual({
      ok: false,
      errors: { form: '找不到这条余额' },
    });
    expect(await anchorsOf(other.accountId)).toHaveLength(1);
  });
});

describeDb('M9-3 createAccount / updateAccount 用途和关联账户（R23.4）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  const linkError = (message: string) => ({ name: 'AccountError', message, field: 'linkedAccountId' });

  it('R23 L1 / L7 / L8 / L9: link, mutual link, unlink, purpose has no type restriction', async () => {
    const plus = t.h.account('ANZ Plus Male').id;
    const male = t.h.account('ANZ Male').id;
    await updateAccount(t.ctx, plus, valuesOf('ANZ Plus Male', { linkedAccountId: male }));
    await updateAccount(t.ctx, male, valuesOf('ANZ Male', { linkedAccountId: plus }));
    expect((await accountRow(plus)).linkedAccountId).toBe(male);
    expect((await accountRow(male)).linkedAccountId).toBe(plus);
    expect(await balanceOf(plus)).toMatchObject({
      linkedAccount: { id: male, name: 'ANZ Male', isArchived: false },
    });

    await updateAccount(t.ctx, plus, valuesOf('ANZ Plus Male', { linkedAccountId: null }));
    expect((await accountRow(plus)).linkedAccountId).toBeNull();

    const joint = t.h.account('ANZ Joint').id;
    await updateAccount(t.ctx, joint, valuesOf('ANZ Joint', { purpose: 'savings' }));
    expect((await accountRow(joint)).purpose).toBe('savings');
    // 不传用途、关联 = 不改
    await updateAccount(t.ctx, joint, valuesOf('ANZ Joint', { name: 'ANZ Joint 2' }));
    expect(await accountRow(joint)).toMatchObject({ name: 'ANZ Joint 2', purpose: 'savings' });
  });

  it('R23 L2 / L3 / L4: self, another household, archived target are rejected', async () => {
    const male = t.h.account('ANZ Male').id;
    const other = await otherHouseholdAccount();
    const old = await createAnzOld();
    const link = (linkedAccountId: string) =>
      updateAccount(t.ctx, male, valuesOf('ANZ Male', { linkedAccountId }));

    await expect(link(male)).rejects.toMatchObject(linkError('不能关联自己'));
    await expect(link(other.accountId)).rejects.toMatchObject(linkError('找不到这个账户'));
    await expect(link(old)).rejects.toMatchObject(linkError('不能关联已归档的账户'));
    expect((await accountRow(male)).linkedAccountId).toBeNull();
  });

  it('R23 L5 / L6: cash accounts cannot link or be linked', async () => {
    const cash = await createCashFemale();
    const female = t.h.account('CBA Female').id;
    await expect(
      updateAccount(t.ctx, cash, {
        name: '现金（Female）',
        bank: 'cash',
        type: 'cash',
        defaultMemberId: t.h.member('Female').id,
        numberSuffix: null,
        linkedAccountId: female,
      }),
    ).rejects.toMatchObject(linkError('现金账户不能关联别的账户'));
    await expect(
      updateAccount(t.ctx, female, valuesOf('CBA Female', { linkedAccountId: cash })),
    ).rejects.toMatchObject(linkError('不能关联现金账户'));
  });

  it('R23 L10 / L11 / L12: archived link stays, unchanged link is not revalidated, relinking fails', async () => {
    const saver = t.h.account('CBA Female Saver').id;
    const female = t.h.account('CBA Female').id;
    await updateAccount(t.ctx, saver, valuesOf('CBA Female Saver', { linkedAccountId: female }));
    await setAccountArchived(t.ctx, female, true);
    expect(await balanceOf(saver)).toMatchObject({
      linkedAccount: { id: female, name: 'CBA Female', isArchived: true },
    });

    // L11
    await updateAccount(
      t.ctx,
      saver,
      valuesOf('CBA Female Saver', { name: 'Saver', linkedAccountId: female }),
    );
    expect(await accountRow(saver)).toMatchObject({ name: 'Saver', linkedAccountId: female });

    // L12
    await updateAccount(t.ctx, saver, valuesOf('CBA Female Saver', { linkedAccountId: null }));
    await expect(
      updateAccount(t.ctx, saver, valuesOf('CBA Female Saver', { linkedAccountId: female })),
    ).rejects.toMatchObject(linkError('不能关联已归档的账户'));
  });

  it('R23.4: createAccount with a link to another household fails and writes nothing', async () => {
    const other = await otherHouseholdAccount();
    await expect(
      createAccount(t.ctx, {
        name: 'Westpac 中转',
        bank: 'other',
        type: 'everyday',
        defaultMemberId: t.h.member('Home').id,
        numberSuffix: '0005',
        purpose: 'bills',
        linkedAccountId: other.accountId,
      }),
    ).rejects.toMatchObject(linkError('找不到这个账户'));
    const rows = await db
      .select()
      .from(schema.financialAccount)
      .where(eq(schema.financialAccount.name, 'Westpac 中转'));
    expect(rows).toHaveLength(0);
    expect(await db.select().from(schema.accountBalance)).toHaveLength(0);
  });

  it('R23.4: createAccount stores purpose and a valid link', async () => {
    const male = t.h.account('ANZ Male').id;
    await createAccount(t.ctx, {
      name: 'Westpac 中转',
      bank: 'other',
      type: 'everyday',
      defaultMemberId: t.h.member('Home').id,
      numberSuffix: '0005',
      purpose: 'goal',
      linkedAccountId: male,
    });
    const [row] = await db
      .select()
      .from(schema.financialAccount)
      .where(eq(schema.financialAccount.name, 'Westpac 中转'));
    expect(row).toMatchObject({ purpose: 'goal', linkedAccountId: male });
  });
});
