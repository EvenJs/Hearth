// M10-4 每月条件的数据层（business-rules.md R24）
// 期望值来自 fixtures/cases/15-monthly-conditions.md。条件、锚点、交易按用例直接插表，今天 = 2026-12-28
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { describeCondition, unknownDepositNote, type ConditionType } from '@/lib/rules/conditions';
import {
  createCondition,
  deactivateCondition,
  getConditionProgress,
  setManualCheck,
  updateCondition,
  type ConditionProgress,
  type CreateConditionInput,
} from '@/server/conditions';
import { undoImport } from '@/server/imports';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

let t: DbTestHousehold;

const TODAY = '2026-12-28';

// 账户名 → id（含 Westpac 中转、ANZ Old；Other ANZ 在别的家庭）
let ids: Map<string, string>;
// K1 … K13 → 条件 id
let k: Map<string, string>;
let other: { householdId: string; accountId: string };
const acc = (name: string) => ids.get(name)!;
const K = (key: string) => k.get(key)!;

// ---------- 插数据 ----------

async function insertAccount(
  name: string,
  values: Partial<typeof schema.financialAccount.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.financialAccount)
    .values({
      householdId: t.ctx.householdId,
      name,
      bank: 'anz',
      type: 'everyday',
      defaultMemberId: t.h.member('Male').id,
      ...values,
    })
    .returning({ id: schema.financialAccount.id });
  ids.set(name, row.id);
  return row.id;
}

async function pdfBatch(account: string, dateFrom: string, dateTo: string, closing: number) {
  const [row] = await db
    .insert(schema.importBatch)
    .values({
      householdId: t.ctx.householdId,
      accountId: acc(account),
      fileName: `${account} ${dateTo}.pdf`,
      source: 'pdf',
      dateFrom,
      dateTo,
      rowCount: 0,
      insertedCount: 0,
      duplicateCount: 0,
      matchedPendingCount: 0,
      closingBalanceCents: closing,
      createdBy: t.ctx.userId,
    })
    .returning({ id: schema.importBatch.id });
  return row.id;
}

async function manualAnchor(account: string, date: string, balanceCents: number) {
  await db.insert(schema.accountBalance).values({
    householdId: t.ctx.householdId,
    accountId: acc(account),
    date,
    balanceCents,
    createdBy: t.ctx.userId,
  });
}

type TxRow = {
  date: string;
  amountCents: number;
  pending?: boolean;
  transfer?: 'none' | 'auto' | 'suggested';
  desc?: string;
  merchant?: string;
  // 'fee' = Bank fees，'transfer' = 内部转账，'' = Uncategorised，其他是分类路径
  cat?: string;
  batchId?: string;
};

function categoryId(cat: string): string {
  if (cat === 'fee') return t.h.systemCategory('bank_fee').id;
  if (cat === 'transfer') return t.h.systemCategory('internal_transfer').id;
  if (cat === '') return t.h.systemCategory('uncategorized').id;
  return t.h.category(cat).id;
}

async function tx(account: string, r: TxRow): Promise<string> {
  const [row] = await db
    .insert(schema.transaction)
    .values({
      householdId: t.ctx.householdId,
      accountId: acc(account),
      date: r.date,
      amountCents: r.amountCents,
      rawDescription: r.desc ?? 'TEST',
      merchant: r.merchant ?? 'TEST',
      status: r.pending ? 'pending' : 'confirmed',
      source: r.pending ? 'manual' : 'csv',
      transferStatus: r.transfer ?? 'none',
      importBatchId: r.batchId ?? null,
      createdBy: t.ctx.userId,
    })
    .returning({ id: schema.transaction.id });
  await db.insert(schema.transactionSplit).values({
    householdId: t.ctx.householdId,
    transactionId: row.id,
    amountCents: r.amountCents,
    categoryId: categoryId(r.cat ?? (r.transfer === 'auto' ? 'transfer' : '')),
    memberId: t.h.member('Male').id,
    categorySource: 'manual',
    memberSource: 'manual',
    isPrimary: true,
  });
  return row.id;
}

async function pair(a: string, b: string) {
  await db
    .update(schema.transaction)
    .set({ transferPairId: b })
    .where(eq(schema.transaction.id, a));
  await db
    .update(schema.transaction)
    .set({ transferPairId: a })
    .where(eq(schema.transaction.id, b));
}

type CondRow = {
  account: string;
  type: ConditionType;
  outcome: 'bonus' | 'fee_waiver';
  amountCents?: number;
  depositFilter?: 'any' | 'exclude_linked';
  cardCount?: number;
  description?: string;
  from: string;
  to?: string;
};

async function condition(
  key: string,
  c: CondRow,
  householdId = t.ctx.householdId,
  accountId?: string,
) {
  const [row] = await db
    .insert(schema.accountCondition)
    .values({
      householdId,
      accountId: accountId ?? acc(c.account),
      type: c.type,
      outcome: c.outcome,
      amountCents: c.amountCents ?? null,
      depositFilter: c.depositFilter ?? null,
      cardCount: c.cardCount ?? null,
      description: c.description ?? null,
      effectiveFrom: c.from,
      disabledFrom: c.to ?? null,
      createdBy: t.ctx.userId,
    })
    .returning({ id: schema.accountCondition.id });
  k.set(key, row.id);
}

const TFER_FROM_PLUS = 'ANZ M-BANKING FUNDS TFER TRANSFER 100000  FROM  ****0004';

// fixtures 15 的基础数据
async function seedBase() {
  ids = new Map(t.h.accounts.map((a) => [a.name, a.id]));
  k = new Map();

  // 关联照 14 号
  await db
    .update(schema.financialAccount)
    .set({ linkedAccountId: acc('ANZ Male') })
    .where(eq(schema.financialAccount.id, acc('ANZ Plus Male')));
  await db
    .update(schema.financialAccount)
    .set({ linkedAccountId: acc('CBA Female') })
    .where(eq(schema.financialAccount.id, acc('CBA Female Saver')));
  await insertAccount('Westpac 中转', { bank: 'other', numberSuffix: '0005' });
  await insertAccount('ANZ Old', { numberSuffix: '0008', isArchived: true });

  // 别的家庭
  const [hh] = await db.insert(schema.household).values({ name: 'Other Household' }).returning();
  const [m] = await db
    .insert(schema.member)
    .values({ householdId: hh.id, name: 'Someone', kind: 'person' })
    .returning();
  const [oa] = await db
    .insert(schema.financialAccount)
    .values({
      householdId: hh.id,
      name: 'Other ANZ',
      bank: 'anz',
      type: 'everyday',
      defaultMemberId: m.id,
      numberSuffix: '0009',
    })
    .returning();
  other = { householdId: hh.id, accountId: oa.id };

  // 条件
  await condition('K1', {
    account: 'ANZ Joint',
    type: 'min_deposit',
    amountCents: 150000,
    depositFilter: 'any',
    outcome: 'fee_waiver',
    from: '2026-09-01',
    to: '2026-10-01',
  });
  await condition('K2', {
    account: 'ANZ Joint',
    type: 'min_deposit',
    amountCents: 200000,
    depositFilter: 'any',
    outcome: 'fee_waiver',
    from: '2026-10-01',
  });
  await condition('K13', {
    account: 'ANZ Joint',
    type: 'min_deposit',
    amountCents: 50000,
    depositFilter: 'any',
    outcome: 'bonus',
    from: '2026-11-01',
    to: '2026-12-01',
  });
  await condition('K3', {
    account: 'ANZ Male',
    type: 'min_deposit',
    amountCents: 100000,
    depositFilter: 'exclude_linked',
    outcome: 'fee_waiver',
    from: '2026-11-01',
  });
  await condition('K4', {
    account: 'ANZ Plus Male',
    type: 'balance_growth',
    outcome: 'bonus',
    from: '2026-11-01',
  });
  await condition('K5', {
    account: 'ANZ Plus Male',
    type: 'linked_min_deposit',
    amountCents: 100000,
    depositFilter: 'exclude_linked',
    outcome: 'bonus',
    from: '2026-11-01',
  });
  await condition('K6', {
    account: 'CBA Female Saver',
    type: 'no_withdrawal',
    outcome: 'bonus',
    from: '2026-11-01',
  });
  await condition('K7', {
    account: 'CBA Female Saver',
    type: 'balance_growth',
    outcome: 'bonus',
    from: '2026-11-01',
  });
  await condition('K8', {
    account: 'CBA Female Saver',
    type: 'linked_card_count',
    cardCount: 5,
    outcome: 'bonus',
    from: '2026-12-01',
  });
  await condition('K9', {
    account: 'CBA Female',
    type: 'other',
    description: '每月登录一次网银',
    outcome: 'fee_waiver',
    from: '2026-11-01',
  });
  await condition('K10', {
    account: 'Westpac 中转',
    type: 'linked_card_count',
    cardCount: 3,
    outcome: 'bonus',
    from: '2026-12-01',
  });
  await condition('K11', {
    account: 'ANZ Old',
    type: 'min_deposit',
    amountCents: 100000,
    depositFilter: 'any',
    outcome: 'fee_waiver',
    from: '2026-09-01',
  });
  await condition(
    'K12',
    {
      account: 'Other ANZ',
      type: 'min_deposit',
      amountCents: 100000,
      depositFilter: 'any',
      outcome: 'fee_waiver',
      from: '2026-09-01',
    },
    other.householdId,
    other.accountId,
  );
  await db.insert(schema.accountConditionCheck).values({
    householdId: t.ctx.householdId,
    conditionId: K('K9'),
    month: '2026-11-01',
    isMet: true,
    createdBy: t.ctx.userId,
  });

  // 锚点
  await pdfBatch('ANZ Plus Male', '2026-10-01', '2026-10-31', 1000000);
  const pdf2 = await pdfBatch('ANZ Plus Male', '2026-11-01', '2026-11-30', 1052500);
  await manualAnchor('CBA Female Saver', '2026-11-30', 1500000);
  await manualAnchor('Westpac 中转', '2026-11-30', 0);

  // ANZ Joint
  const J = 'ANZ Joint';
  await tx(J, { date: '2026-08-20', amountCents: 300000, cat: 'Income / Salary' });
  await tx(J, { date: '2026-09-15', amountCents: 160000, cat: 'Income / Salary' });
  await tx(J, { date: '2026-10-01', amountCents: 200000, cat: 'Income / Salary' });
  await tx(J, { date: '2026-10-30', amountCents: -500, cat: 'fee', desc: 'ACCOUNT SERVICING FEE' });
  await tx(J, {
    date: '2026-10-30',
    amountCents: 500,
    cat: 'fee',
    desc: 'REVERSAL OF ACCOUNT SERVICING FEE MINIMUM $2000 IN DEPOSITS RECEIVED',
  });
  await tx(J, { date: '2026-11-02', amountCents: 199600, cat: 'Income / Salary' });
  await tx(J, { date: '2026-11-30', amountCents: -500, cat: 'fee' });
  await tx(J, { date: '2026-11-30', amountCents: 500, cat: 'fee' });
  await tx(J, { date: '2026-12-01', amountCents: 150000, cat: 'Income / Salary' });
  await tx(J, { date: '2026-12-05', amountCents: 2312, cat: 'Income / Interest' });
  await tx(J, { date: '2026-12-08', amountCents: 1999, cat: 'Groceries / Supermarket' });
  await tx(J, { date: '2026-12-10', amountCents: -5000, cat: 'Groceries / Supermarket' });
  const j12 = await tx(J, { date: '2026-12-12', amountCents: 30000, transfer: 'auto' });
  await tx(J, { date: '2026-12-16', amountCents: 10000, transfer: 'auto', desc: TFER_FROM_PLUS });
  await tx(J, { date: '2026-12-20', amountCents: -4321, cat: 'Groceries / Supermarket' });
  await tx(J, { date: '2026-12-27', amountCents: 8000, pending: true, cat: 'Income / Other' });

  // ANZ Male
  const M = 'ANZ Male';
  await tx(M, { date: '2026-11-05', amountCents: 100000, cat: 'Income / Salary' });
  const n2 = await tx(M, { date: '2026-11-10', amountCents: -50000, transfer: 'auto' });
  await tx(M, { date: '2026-11-30', amountCents: -500, cat: 'fee' });
  await tx(M, { date: '2026-12-01', amountCents: -500, cat: 'fee' });
  await tx(M, { date: '2026-12-02', amountCents: 120000, transfer: 'auto', desc: TFER_FROM_PLUS });
  await tx(M, { date: '2026-12-09', amountCents: 30000 });
  const m4 = await tx(M, { date: '2026-12-12', amountCents: -30000, transfer: 'auto' });
  const m5 = await tx(M, { date: '2026-12-15', amountCents: 50000, transfer: 'auto' });

  // ANZ Plus Male
  const p1 = await tx('ANZ Plus Male', {
    date: '2026-11-10',
    amountCents: 50000,
    transfer: 'auto',
    batchId: pdf2,
  });
  await tx('ANZ Plus Male', {
    date: '2026-11-30',
    amountCents: 2500,
    cat: 'Income / Interest',
    batchId: pdf2,
  });

  // CBA Female Saver
  const S = 'CBA Female Saver';
  await tx(S, { date: '2026-11-30', amountCents: 900, cat: 'Income / Interest' });
  const s2 = await tx(S, { date: '2026-12-06', amountCents: 50000, transfer: 'auto' });
  await tx(S, { date: '2026-12-10', amountCents: 120, cat: 'Income / Interest' });
  await tx(S, { date: '2026-12-15', amountCents: -120, cat: 'Income / Interest' });
  await tx(S, { date: '2026-12-16', amountCents: -500, cat: 'fee' });

  // CBA Female
  const F = 'CBA Female';
  await tx(F, { date: '2026-12-02', amountCents: -4500, cat: 'Groceries / Supermarket' });
  await tx(F, {
    date: '2026-12-04',
    amountCents: -1200,
    cat: 'Transport & auto / Public transport',
  });
  const f3 = await tx(F, { date: '2026-12-06', amountCents: -50000, transfer: 'auto' });
  await tx(F, { date: '2026-12-08', amountCents: -2000, transfer: 'suggested' });
  await tx(F, { date: '2026-12-10', amountCents: -600, cat: 'fee' });
  await tx(F, {
    date: '2026-12-12',
    amountCents: -3300,
    cat: 'Entertainment & eat-out / Restaurants',
  });
  const f7 = await tx(F, { date: '2026-12-14', amountCents: -50000, transfer: 'auto' });
  await tx(F, { date: '2026-12-18', amountCents: 1500, cat: 'Groceries / Supermarket' });
  await tx(F, {
    date: '2026-12-20',
    amountCents: -800,
    pending: true,
    cat: 'Groceries / Supermarket',
  });
  await tx(F, {
    date: '2026-12-22',
    amountCents: -2100,
    cat: 'Entertainment & eat-out / Restaurants',
  });

  // ANZ Old
  await tx('ANZ Old', { date: '2026-12-05', amountCents: 10000 });

  await pair(j12, m4);
  await pair(n2, p1);
  await pair(m5, f7);
  await pair(s2, f3);
}

// ---------- 取结果 ----------

function accountOf(p: ConditionProgress, name: string) {
  const a = p.accounts.find((x) => x.accountId === acc(name));
  if (!a) throw new Error(`进度里没有 ${name}`);
  return a;
}

function monthOf(p: ConditionProgress, name: string, month: string) {
  const m = accountOf(p, name).history.find((x) => x.month === month);
  if (!m) throw new Error(`${name} 的历史里没有 ${month}`);
  return m;
}

function resultOf(p: ConditionProgress, name: string, month: string, key: string) {
  const r = monthOf(p, name, month).results.find((x) => x.conditionId === K(key));
  if (!r) throw new Error(`${name} ${month} 没有 ${key}`);
  return r;
}

describeDb('M10-4 getConditionProgress / createCondition / setManualCheck（R24）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    await seedBase();
  });

  it('R24 A-1 / B-1 / C-1 / D-2 / D-5 / E-1 / E-2 / E-3 / G-1: this month, today 2026-12-28', async () => {
    const p = await getConditionProgress(t.ctx, TODAY);
    const dec = '2026-12-01';

    const k2 = resultOf(p, 'ANZ Joint', dec, 'K2');
    expect(k2).toMatchObject({
      status: 'in_progress',
      currentValue: 191999,
      remaining: 8001,
      asOf: '2026-12-20',
    });
    expect(describeCondition(k2)).toBe('存入 $1,919.99 / $2,000.00，还差 $80.01');
    expect(unknownDepositNote(k2)).toBeNull();

    const k3 = resultOf(p, 'ANZ Male', dec, 'K3');
    expect(k3).toMatchObject({
      status: 'in_progress',
      currentValue: 80000,
      remaining: 20000,
      asOf: '2026-12-15',
    });
    expect(unknownDepositNote(k3)).toBe('1 笔存入认不出来自哪个账户，按算数处理');

    expect(describeCondition(resultOf(p, 'CBA Female Saver', dec, 'K6'))).toBe('到目前没有取款');
    expect(resultOf(p, 'CBA Female Saver', dec, 'K6').asOf).toBe('2026-12-16');

    const k4 = resultOf(p, 'ANZ Plus Male', dec, 'K4');
    expect(k4).toMatchObject({
      status: 'in_progress',
      currentValue: 1052500,
      target: 1052500,
      asOf: '2026-11-30',
    });
    expect(describeCondition(k4)).toBe('现在 $10,525.00，和上月末一样');

    const k7 = resultOf(p, 'CBA Female Saver', dec, 'K7');
    expect(k7).toMatchObject({ status: 'in_progress', currentValue: 1549500, target: 1500000 });

    const k5 = resultOf(p, 'ANZ Plus Male', dec, 'K5');
    expect(k5).toMatchObject({
      status: 'in_progress',
      currentValue: 80000,
      remaining: 20000,
      asOf: '2026-12-15',
    });
    expect(describeCondition(k5)).toBe('ANZ Male：存入 $800.00 / $1,000.00，还差 $200.00');

    const k8 = resultOf(p, 'CBA Female Saver', dec, 'K8');
    expect(k8).toMatchObject({
      status: 'in_progress',
      currentValue: 4,
      remaining: 1,
      asOf: '2026-12-22',
    });
    expect(describeCondition(k8)).toBe('CBA Female：刷卡 4 / 5 笔，还差 1 笔');

    const k10 = resultOf(p, 'Westpac 中转', dec, 'K10');
    expect(k10).toMatchObject({ status: 'unknown', unknownReason: 'no_linked_account' });

    expect(resultOf(p, 'CBA Female', dec, 'K9')).toMatchObject({
      status: 'unknown',
      unknownReason: 'not_checked',
    });
  });

  it('R24 A-4 / B-2 / D-1 / D-4 / F-1: past months and outcome summaries', async () => {
    const p = await getConditionProgress(t.ctx, TODAY);

    expect(resultOf(p, 'ANZ Joint', '2026-09-01', 'K1')).toMatchObject({
      status: 'met',
      currentValue: 160000,
    });
    expect(resultOf(p, 'ANZ Joint', '2026-10-01', 'K2')).toMatchObject({
      status: 'met',
      currentValue: 200000,
    });
    const nov = monthOf(p, 'ANZ Joint', '2026-11-01');
    expect(resultOf(p, 'ANZ Joint', '2026-11-01', 'K2')).toMatchObject({
      status: 'failed',
      currentValue: 199600,
      remaining: 400,
      stale: false,
    });
    expect(resultOf(p, 'ANZ Joint', '2026-11-01', 'K13')).toMatchObject({ status: 'met' });
    expect(nov.summary.byOutcome).toEqual({ bonus: 'met', fee_waiver: 'failed' });

    expect(resultOf(p, 'ANZ Male', '2026-11-01', 'K3')).toMatchObject({
      status: 'met',
      currentValue: 100000,
      unknownDepositCount: 1,
    });

    const k4 = resultOf(p, 'ANZ Plus Male', '2026-11-01', 'K4');
    expect(k4).toMatchObject({ status: 'met', currentValue: 1052500, target: 1000000 });
    expect(describeCondition(k4)).toBe('月末 $10,525.00，比上月末多 $525.00');
    expect(monthOf(p, 'ANZ Plus Male', '2026-11-01').summary.byOutcome).toEqual({ bonus: 'met' });

    expect(resultOf(p, 'CBA Female Saver', '2026-11-01', 'K7')).toMatchObject({
      status: 'unknown',
      unknownReason: 'no_balance',
    });
    expect(resultOf(p, 'CBA Female Saver', '2026-11-01', 'K6')).toMatchObject({ status: 'met' });
    expect(monthOf(p, 'CBA Female Saver', '2026-11-01').summary.byOutcome).toEqual({
      bonus: 'unknown',
    });

    expect(resultOf(p, 'CBA Female', '2026-11-01', 'K9')).toMatchObject({ status: 'met' });
  });

  it('R24.8 H-1 / H-2 / H-4 / H-5 / H-7: fee mismatch uses net Bank fees in the same month', async () => {
    const p = await getConditionProgress(t.ctx, TODAY);
    expect(monthOf(p, 'ANZ Male', '2026-11-01').feeMismatchCents).toBe(500);
    expect(monthOf(p, 'ANZ Male', '2026-12-01').feeMismatchCents).toBeNull();
    expect(monthOf(p, 'ANZ Joint', '2026-10-01').feeMismatchCents).toBeNull();
    expect(monthOf(p, 'ANZ Joint', '2026-11-01').feeMismatchCents).toBeNull();
    expect(monthOf(p, 'ANZ Joint', '2026-09-01').feeMismatchCents).toBeNull();
    for (const m of accountOf(p, 'CBA Female Saver').history) expect(m.feeMismatchCents).toBeNull();
  });

  it('R24.9 I-1 / I-2: one home reminder line, only in the last 5 days', async () => {
    expect((await getConditionProgress(t.ctx, TODAY)).reminder).toEqual({
      count: 5,
      asOf: '2026-11-30',
      text: '5 个账户条件本月还没满足（数据截至 11-30）',
    });
    expect((await getConditionProgress(t.ctx, '2026-12-26')).reminder).toBeNull();
    expect((await getConditionProgress(t.ctx, '2026-12-27')).reminder?.count).toBe(5);
    expect((await getConditionProgress(t.ctx, '2027-01-01')).reminder).toBeNull();
  });

  it('R24.10 J: history from the earliest effective_from, monthly interest; archived and other household hidden', async () => {
    const p = await getConditionProgress(t.ctx, TODAY);
    const cells = (name: string) =>
      accountOf(p, name).history.map((m) => [
        m.month.slice(0, 7),
        m.summary.overall,
        m.interestCents,
      ]);

    expect(cells('ANZ Joint')).toEqual([
      ['2026-09', 'met', 0],
      ['2026-10', 'met', 0],
      ['2026-11', 'failed', 0],
      ['2026-12', 'in_progress', 2312],
    ]);
    expect(cells('ANZ Male')).toEqual([
      ['2026-11', 'met', 0],
      ['2026-12', 'in_progress', 0],
    ]);
    expect(cells('ANZ Plus Male')).toEqual([
      ['2026-11', 'met', 2500],
      ['2026-12', 'in_progress', 0],
    ]);
    expect(cells('CBA Female Saver')).toEqual([
      ['2026-11', 'unknown', 900],
      ['2026-12', 'in_progress', 0],
    ]);
    expect(cells('CBA Female')).toEqual([
      ['2026-11', 'met', 0],
      ['2026-12', 'unknown', 0],
    ]);
    expect(cells('Westpac 中转')).toEqual([['2026-12', 'unknown', 0]]);

    // 有条件的账户才出现；ANZ Old 归档了，Other ANZ 是别的家庭
    expect(p.accounts.map((a) => a.accountName)).toEqual([
      'ANZ Joint',
      'ANZ Male',
      'CBA Female',
      'CBA Female Saver',
      'ANZ Plus Male',
      'Westpac 中转',
    ]);
    // 本月条件：ANZ Joint 只有 K2；CBA Female Saver 三行
    expect(accountOf(p, 'ANZ Joint').thisMonth?.results.map((r) => r.conditionId)).toEqual([
      K('K2'),
    ]);
    expect(accountOf(p, 'CBA Female Saver').thisMonth?.results.map((r) => r.conditionId)).toEqual([
      K('K6'),
      K('K7'),
      K('K8'),
    ]);
  });

  it('R24.7 G-2 – G-6 / H-3: manual check for other; only judged months up to this month', async () => {
    const dec = '2026-12-01';
    expect(await setManualCheck(t.ctx, K('K9'), '2026-12-15', true, TODAY)).toEqual({ ok: true });
    let p = await getConditionProgress(t.ctx, TODAY);
    expect(resultOf(p, 'CBA Female', dec, 'K9').status).toBe('met');
    expect(monthOf(p, 'CBA Female', dec).feeMismatchCents).toBe(600);

    expect(await setManualCheck(t.ctx, K('K9'), dec, false, TODAY)).toEqual({ ok: true });
    p = await getConditionProgress(t.ctx, TODAY);
    expect(resultOf(p, 'CBA Female', dec, 'K9').status).toBe('failed');

    expect(await setManualCheck(t.ctx, K('K9'), dec, null, TODAY)).toEqual({ ok: true });
    p = await getConditionProgress(t.ctx, TODAY);
    expect(resultOf(p, 'CBA Female', dec, 'K9')).toMatchObject({
      status: 'unknown',
      unknownReason: 'not_checked',
    });
    // 11 月的勾不受影响
    expect(resultOf(p, 'CBA Female', '2026-11-01', 'K9').status).toBe('met');

    expect(await setManualCheck(t.ctx, K('K9'), '2027-01-01', true, TODAY)).toMatchObject({
      ok: false,
    });
    expect(await setManualCheck(t.ctx, K('K9'), '2026-10-01', true, TODAY)).toMatchObject({
      ok: false,
    });
    // 不是 other 的不能勾
    expect(await setManualCheck(t.ctx, K('K2'), dec, true, TODAY)).toMatchObject({ ok: false });
  });

  it('R24.1 K-1 – K-9: validation order and messages', async () => {
    const base = { outcome: 'bonus' as const, effectiveFrom: TODAY };
    const create = (account: string, rest: Partial<CreateConditionInput>) =>
      createCondition(
        t.ctx,
        { ...base, accountId: account, ...rest } as CreateConditionInput,
        TODAY,
      );

    expect(
      await create(acc('Westpac 中转'), {
        type: 'linked_min_deposit',
        amountCents: 100,
        depositFilter: 'any',
      }),
    ).toEqual({
      ok: false,
      errors: { type: '这个账户还没有设置关联账户' },
    });
    expect(
      await create(acc('ANZ Male'), { type: 'min_deposit', amountCents: 0, depositFilter: 'any' }),
    ).toEqual({
      ok: false,
      errors: { amountCents: '金额要大于 $0' },
    });
    expect(
      await create(acc('CBA Female Saver'), { type: 'linked_card_count', cardCount: 0 }),
    ).toEqual({
      ok: false,
      errors: { cardCount: '笔数至少 1 笔' },
    });
    expect(await create(acc('CBA Female'), { type: 'other', description: '  ' })).toEqual({
      ok: false,
      errors: { description: '写一下条件是什么' },
    });
    expect(
      await create(acc('ANZ Male'), { type: 'no_withdrawal', effectiveFrom: '2027-01-01' }),
    ).toEqual({
      ok: false,
      errors: { effectiveFrom: '生效月份不能晚于本月' },
    });
    expect(
      await create(acc('ANZ Old'), {
        type: 'min_deposit',
        amountCents: 100000,
        depositFilter: 'any',
      }),
    ).toEqual({
      ok: false,
      errors: { accountId: '归档的账户不能加条件' },
    });
    expect(
      await create(other.accountId, {
        type: 'min_deposit',
        amountCents: 100000,
        depositFilter: 'any',
      }),
    ).toEqual({
      ok: false,
      errors: { accountId: '找不到这个账户' },
    });

    const cash = await insertAccount('现金（Female）', {
      bank: 'cash',
      type: 'cash',
      defaultMemberId: t.h.member('Female').id,
    });
    const ok = await create(cash, {
      type: 'min_deposit',
      amountCents: 10000,
      depositFilter: 'any',
      effectiveFrom: '2026-12-15',
    });
    expect(ok).toMatchObject({ ok: true });
    const [row] = await db
      .select()
      .from(schema.accountCondition)
      .where(eq(schema.accountCondition.id, (ok as { id: string }).id));
    expect(row).toMatchObject({
      effectiveFrom: '2026-12-01',
      disabledFrom: null,
      cardCount: null,
      description: null,
    });
    expect(await create(cash, { type: 'linked_card_count', cardCount: 3 })).toEqual({
      ok: false,
      errors: { type: '这个账户还没有设置关联账户' },
    });
  });

  it('R24.1 K-10 / K-11 / K-13 / K-14: update = disable old + create new; delete = disable', async () => {
    const updated = await updateCondition(
      t.ctx,
      K('K2'),
      { type: 'min_deposit', outcome: 'fee_waiver', amountCents: 250000, depositFilter: 'any' },
      TODAY,
    );
    expect(updated).toMatchObject({ ok: true });
    k.set("K2'", (updated as { id: string }).id);
    // 停用的不能再改、再删
    expect(await deactivateCondition(t.ctx, K('K2'), TODAY)).toMatchObject({ ok: false });

    expect(await deactivateCondition(t.ctx, K('K3'), TODAY)).toEqual({ ok: true });

    // K-13 本月新加又删掉
    const added = await createCondition(
      t.ctx,
      { accountId: acc('ANZ Male'), type: 'no_withdrawal', outcome: 'bonus', effectiveFrom: TODAY },
      TODAY,
    );
    expect(await deactivateCondition(t.ctx, (added as { id: string }).id, TODAY)).toEqual({
      ok: true,
    });

    const rows = await db
      .select()
      .from(schema.accountCondition)
      .where(eq(schema.accountCondition.householdId, t.ctx.householdId));
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    expect(byId(K('K2')).disabledFrom).toBe('2026-12-01');
    expect(byId(K("K2'"))).toMatchObject({
      amountCents: 250000,
      effectiveFrom: '2026-12-01',
      disabledFrom: null,
    });
    expect(byId(K('K3')).disabledFrom).toBe('2026-12-01');
    expect(byId((added as { id: string }).id)).toMatchObject({
      effectiveFrom: '2026-12-01',
      disabledFrom: '2026-12-01',
    });
    // K-14：ANZ Joint 在用的只有 K2'
    expect(
      rows
        .filter((r) => r.accountId === acc('ANZ Joint') && r.disabledFrom === null)
        .map((r) => r.id),
    ).toEqual([K("K2'")]);

    const p = await getConditionProgress(t.ctx, TODAY);
    const k2new = resultOf(p, 'ANZ Joint', '2026-12-01', "K2'");
    expect(describeCondition(k2new)).toBe('存入 $1,919.99 / $2,500.00，还差 $580.01');
    expect(resultOf(p, 'ANZ Joint', '2026-10-01', 'K2').status).toBe('met');
    expect(resultOf(p, 'ANZ Joint', '2026-11-01', 'K2')).toMatchObject({
      status: 'failed',
      remaining: 400,
    });

    const male = accountOf(p, 'ANZ Male');
    expect(male.thisMonth).toBeNull();
    expect(male.history.map((m) => [m.month, m.results.length])).toEqual([
      ['2026-11-01', 1],
      ['2026-12-01', 0],
    ]);
    expect(monthOf(p, 'ANZ Male', '2026-11-01').feeMismatchCents).toBe(500);
    expect(p.reminder?.count).toBe(4);
  });

  it('R24.1: other household cannot update, deactivate or check conditions', async () => {
    const otherCtx = { ...t.ctx, householdId: other.householdId };
    expect(
      await updateCondition(otherCtx, K('K2'), { type: 'no_withdrawal', outcome: 'bonus' }, TODAY),
    ).toEqual({ ok: false, errors: { form: '找不到这个条件' } });
    expect(await deactivateCondition(otherCtx, K('K2'), TODAY)).toEqual({
      ok: false,
      errors: { form: '找不到这个条件' },
    });
    expect(await setManualCheck(otherCtx, K('K9'), '2026-12-01', true, TODAY)).toEqual({
      ok: false,
      errors: { form: '找不到这个条件' },
    });
    // 本家庭也勾不了别的家庭的
    expect(await setManualCheck(t.ctx, K('K12'), '2026-12-01', true, TODAY)).toMatchObject({
      ok: false,
    });

    const rows = await db
      .select()
      .from(schema.accountCondition)
      .where(eq(schema.accountCondition.id, K('K2')));
    expect(rows[0].disabledFrom).toBeNull();
    const checks = await db.select().from(schema.accountConditionCheck);
    expect(checks).toHaveLength(1); // 只有基础数据里 K9 11 月那条
  });

  it('R24 D-3: importing the December statement changes the result; undoing it changes it back', async () => {
    const today = '2027-01-05';
    const pdf3 = await pdfBatch('ANZ Plus Male', '2026-12-01', '2026-12-31', 925100);
    const p3 = await tx('ANZ Plus Male', {
      date: '2026-12-02',
      amountCents: -120000,
      transfer: 'auto',
      batchId: pdf3,
    });
    const p4 = await tx('ANZ Plus Male', {
      date: '2026-12-16',
      amountCents: -10000,
      transfer: 'auto',
      batchId: pdf3,
    });
    await tx('ANZ Plus Male', {
      date: '2026-12-31',
      amountCents: 2600,
      cat: 'Income / Interest',
      batchId: pdf3,
    });
    const [m2] = await db
      .select({ id: schema.transaction.id })
      .from(schema.transaction)
      .where(
        and(
          eq(schema.transaction.accountId, acc('ANZ Male')),
          eq(schema.transaction.date, '2026-12-02'),
        ),
      );
    const [j13] = await db
      .select({ id: schema.transaction.id })
      .from(schema.transaction)
      .where(
        and(
          eq(schema.transaction.accountId, acc('ANZ Joint')),
          eq(schema.transaction.date, '2026-12-16'),
        ),
      );
    await pair(p3, m2.id);
    await pair(p4, j13.id);

    let p = await getConditionProgress(t.ctx, today);
    const k4 = resultOf(p, 'ANZ Plus Male', '2026-12-01', 'K4');
    expect(k4).toMatchObject({
      status: 'failed',
      currentValue: 925100,
      target: 1052500,
      stale: false,
    });
    expect(describeCondition(k4)).toBe('月末 $9,251.00，比上月末少 $1,274.00');
    expect(resultOf(p, 'ANZ Male', '2026-12-01', 'K3').currentValue).toBe(80000);
    expect(resultOf(p, 'ANZ Plus Male', '2026-12-01', 'K5').currentValue).toBe(80000);
    expect(monthOf(p, 'ANZ Plus Male', '2026-12-01').interestCents).toBe(2600);

    expect(await undoImport(t.ctx, pdf3)).toMatchObject({ ok: true });
    p = await getConditionProgress(t.ctx, today);
    expect(resultOf(p, 'ANZ Plus Male', '2026-12-01', 'K4')).toMatchObject({
      status: 'failed',
      currentValue: 1052500,
      target: 1052500,
      asOf: '2026-11-30',
      stale: true,
    });
    // m2 没了配对，照样从描述认出是 ANZ Plus Male 转回来的
    expect(resultOf(p, 'ANZ Male', '2026-12-01', 'K3').currentValue).toBe(80000);
    expect(monthOf(p, 'ANZ Plus Male', '2026-12-01').interestCents).toBe(0);
  });
});
