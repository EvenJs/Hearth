// M11-4 目标和应急金的数据层（business-rules.md R25、R22.2）
// 期望值来自 fixtures/cases/16-goals.md，今天 = 2026-12-15。账户、锚点、交易、目标按用例直接插表
// 全家的收支（用例"直接给"的那部分）用 ANZ Joint 上的补数交易凑：ANZ Joint 不挂目标，不影响余额和净流入
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { maskLongDigits } from '@/lib/rules/extract';
import { updateAccount } from '@/server/accounts';
import {
  completeGoal,
  createGoal,
  deleteGoal,
  getBudgetSpendable,
  getGoals,
  linkSplitToGoal,
  moveGoal,
  reopenGoal,
  updateGoal,
  type ActiveGoal,
  type GoalInput,
  type GoalsOverview,
} from '@/server/goals';
import { undoImport } from '@/server/imports';
import { addSplit } from '@/server/splits';
import { updateSplitCategory } from '@/server/transactions';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

let t: DbTestHousehold;

const TODAY = '2026-12-15';

const HOLIDAYS = 'Entertainment & eat-out / Holidays';
const GADGETS = 'Personal & medical / Computers & gadgets';
const CLOTHING = 'Personal & medical / Clothing & shoes';
const SUPERMARKET = 'Groceries / Supermarket';
const SALARY = 'Income / Salary';
const INTEREST = 'Income / Interest';
const INCOME_OTHER = 'Income / Other';
const INTERNAL = 'internal';

// ---------- 账户 ----------

// 测试家庭里没有的账户：ANZ Card、BOQ 中转、Westpac 中转、ANZ Old（已归档）、现金（Female）
let accounts: Map<string, string>;

async function insertAccount(
  name: string,
  bank: 'anz' | 'cash' | 'other',
  type: 'everyday' | 'credit_card' | 'cash',
  member: string,
  isArchived = false,
): Promise<string> {
  const [row] = await db
    .insert(schema.financialAccount)
    .values({
      householdId: t.ctx.householdId,
      name,
      bank,
      type,
      defaultMemberId: t.h.member(member).id,
      isArchived,
    })
    .returning({ id: schema.financialAccount.id });
  return row.id;
}

const accountId = (name: string) => {
  const id = accounts.get(name);
  if (!id) throw new Error(`没有账户 ${name}`);
  return id;
};

// ---------- 锚点 ----------

async function manualAnchor(account: string, date: string, balanceCents: number) {
  await db.insert(schema.accountBalance).values({
    householdId: t.ctx.householdId,
    accountId: accountId(account),
    date,
    balanceCents,
    createdBy: t.ctx.userId,
  });
}

async function batch(
  account: string,
  source: 'csv' | 'pdf',
  dateTo: string,
  closing: number | null,
) {
  const [row] = await db
    .insert(schema.importBatch)
    .values({
      householdId: t.ctx.householdId,
      accountId: accountId(account),
      fileName: `${account}.${source}`,
      source,
      dateFrom: dateTo,
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

// ---------- 交易 ----------

type TxOptions = {
  isOneOff?: boolean | null;
  batchId?: string;
  categorySource?: 'manual' | 'rule';
  rawDescription?: string;
};

// 用例的 # 写在 merchant 上。一笔交易一个拆分
const txIds = new Map<string, string>();
const splitIds = new Map<string, string>();

async function addTx(
  account: string,
  name: string,
  date: string,
  amountCents: number,
  category: string,
  o: TxOptions = {},
): Promise<void> {
  const accId = accountId(account);
  const internal = category === INTERNAL;
  const c = internal ? t.h.systemCategory('internal_transfer') : t.h.category(category);
  const memberId =
    t.h.accounts.find((a) => a.id === accId)?.defaultMemberId ?? t.h.member('Home').id;
  const [row] = await db
    .insert(schema.transaction)
    .values({
      householdId: t.ctx.householdId,
      accountId: accId,
      date,
      amountCents,
      rawDescription: o.rawDescription ?? name,
      merchant: name,
      status: 'confirmed',
      source: o.batchId ? 'csv' : 'manual',
      transferStatus: internal ? 'auto' : 'none',
      importBatchId: o.batchId ?? null,
      createdBy: t.ctx.userId,
    })
    .returning({ id: schema.transaction.id });
  const [split] = await db
    .insert(schema.transactionSplit)
    .values({
      householdId: t.ctx.householdId,
      transactionId: row.id,
      amountCents,
      categoryId: c.id,
      memberId,
      categorySource: internal ? 'system' : (o.categorySource ?? 'manual'),
      memberSource: 'account',
      isPrimary: true,
      isPreTax: c.isPreTaxDefault,
      isOneOff: o.isOneOff ?? null,
    })
    .returning({ id: schema.transactionSplit.id });
  txIds.set(name, row.id);
  splitIds.set(name, split.id);
}

const splitOf = (name: string) => splitIds.get(name)!;

async function splitRow(name: string) {
  const [row] = await db
    .select()
    .from(schema.transactionSplit)
    .where(eq(schema.transactionSplit.id, splitOf(name)));
  return row;
}

async function setGoalOnSplit(name: string, goal: string | null, isOneOff: boolean | null) {
  await db
    .update(schema.transactionSplit)
    .set({ goalId: goal === null ? null : goalId(goal), isOneOff })
    .where(eq(schema.transactionSplit.id, splitOf(name)));
}

// ---------- 目标 ----------

const goals = new Map<string, string>();
const goalId = (key: string) => {
  const id = goals.get(key);
  if (!id) throw new Error(`没有目标 ${key}`);
  return id;
};

type GoalRow = [
  key: string,
  name: string,
  kind: 'keep' | 'spend',
  recurrence: 'once' | 'yearly',
  targetCents: number | null,
  targetDate: string | null,
  account: string | null,
  priority: number,
  status: 'active' | 'done',
  isPinned: boolean,
];

// 用例"目标"表
const GOALS: GoalRow[] = [
  ['E', '应急金', 'keep', 'once', null, null, 'CBA Female Saver', 0, 'active', true],
  ['G1', '包', 'spend', 'once', 500000, '2027-03-20', 'ANZ Plus Male', 1, 'active', false],
  ['G2', '旅行', 'spend', 'once', 400000, '2027-06-10', 'ANZ Plus Male', 2, 'active', true],
  ['G3', '首付', 'keep', 'once', 5000000, null, 'CBA Female Saver', 3, 'active', false],
  ['G4', '换手机', 'spend', 'once', 150000, '2027-05-01', 'ANZ Card', 4, 'active', false],
  ['G5', 'rego', 'spend', 'yearly', 80000, '2027-03-15', 'ANZ Male', 5, 'active', false],
  ['G6', '沙发', 'spend', 'once', 100000, '2027-02-15', 'CBA Female', 6, 'active', false],
  ['G7', '相机', 'spend', 'once', 150000, '2026-12-20', 'CBA Female', 7, 'done', false],
  ['G8', '自行车', 'spend', 'once', 250000, '2027-04-10', 'CBA Female', 8, 'active', false],
  ['G9', '圣诞礼物', 'spend', 'once', 60000, '2026-12-24', null, 9, 'active', false],
  ['G10', '日本旅行', 'spend', 'once', 300000, '2026-11-30', null, 10, 'active', false],
  ['G11', '电脑', 'spend', 'once', 200000, '2027-08-01', 'BOQ 中转', 11, 'active', false],
  ['G12', '婚礼礼金', 'spend', 'once', 50000, '2027-01-20', 'ANZ Old', 12, 'active', false],
  ['G13', '会员年费', 'spend', 'yearly', 20000, '2028-02-29', null, 13, 'active', false],
];

async function insertGoals() {
  for (const [
    key,
    name,
    kind,
    recurrence,
    targetCents,
    targetDate,
    account,
    priority,
    status,
    isPinned,
  ] of GOALS) {
    const isEmergency = key === 'E';
    const [row] = await db
      .insert(schema.goal)
      .values({
        householdId: t.ctx.householdId,
        name,
        kind,
        recurrence,
        targetCents,
        targetDate,
        accountId: account === null ? null : accountId(account),
        priority,
        isEmergency,
        emergencyMonths: isEmergency ? 6 : null,
        isPinned,
        status,
        doneAt: status === 'done' ? new Date('2026-12-05T01:00:00Z') : null,
        createdBy: t.ctx.userId,
      })
      .returning({ id: schema.goal.id });
    goals.set(key, row.id);
  }
}

// 别的家庭：一个账户 Other ANZ、一个目标 Other 目标
async function insertOtherHousehold() {
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
    })
    .returning({ id: schema.financialAccount.id });
  accounts.set('Other ANZ', a.id);
  const [g] = await db
    .insert(schema.goal)
    .values({
      householdId: hh.id,
      name: 'Other 目标',
      kind: 'spend',
      recurrence: 'once',
      targetCents: 10000,
      priority: 1,
      createdBy: t.ctx.userId,
    })
    .returning({ id: schema.goal.id });
  goals.set('Other', g.id);
}

// ---------- 基础数据 ----------

let jointBatchId: string;

async function insertBase() {
  accounts = new Map(t.h.accounts.map((a) => [a.name, a.id]));
  txIds.clear();
  splitIds.clear();
  goals.clear();
  accounts.set('ANZ Card', await insertAccount('ANZ Card', 'anz', 'credit_card', 'Male'));
  accounts.set('BOQ 中转', await insertAccount('BOQ 中转', 'other', 'everyday', 'Male'));
  accounts.set('Westpac 中转', await insertAccount('Westpac 中转', 'other', 'everyday', 'Male'));
  accounts.set('ANZ Old', await insertAccount('ANZ Old', 'anz', 'everyday', 'Male', true));
  accounts.set('现金（Female）', await insertAccount('现金（Female）', 'cash', 'cash', 'Female'));
  await insertOtherHousehold();

  // 锚点
  await batch('ANZ Plus Male', 'pdf', '2026-11-30', 650000);
  await manualAnchor('ANZ Male', '2026-11-30', 50000);
  await manualAnchor('CBA Female', '2026-11-30', 448000);
  await manualAnchor('CBA Female Saver', '2026-11-30', 1557766);
  await manualAnchor('ANZ Card', '2026-11-15', -45000);
  await manualAnchor('Westpac 中转', '2026-11-30', 0);

  // ANZ Plus Male
  await addTx('ANZ Plus Male', 'p1', '2026-09-10', 30000, INTERNAL);
  await addTx('ANZ Plus Male', 'p2', '2026-10-10', 30000, INTERNAL);
  await addTx('ANZ Plus Male', 'p3', '2026-11-10', 28000, INTERNAL);
  await addTx('ANZ Plus Male', 'p4', '2026-11-30', 2000, INTEREST);
  await addTx('ANZ Plus Male', 'p5', '2026-12-05', 50000, INTERNAL);
  // ANZ Male
  for (const [i, month] of ['09', '10', '11'].entries()) {
    await addTx('ANZ Male', `n${i * 3 + 1}`, `2026-${month}-01`, 100000, SALARY);
  }
  await addTx('ANZ Male', 'n2', '2026-09-10', -30000, INTERNAL);
  await addTx('ANZ Male', 'n3', '2026-09-15', -70000, INTERNAL);
  await addTx('ANZ Male', 'n5', '2026-10-10', -30000, INTERNAL);
  await addTx('ANZ Male', 'n6', '2026-10-15', -70000, INTERNAL);
  await addTx('ANZ Male', 'n8', '2026-11-10', -28000, INTERNAL);
  await addTx('ANZ Male', 'n9', '2026-11-15', -72000, INTERNAL);
  // CBA Female
  await addTx('CBA Female', 'f1', '2026-11-05', -180000, HOLIDAYS, { isOneOff: true });
  await addTx('CBA Female', 'f3', '2026-11-25', 250000, SALARY);
  await addTx('CBA Female', 'f2', '2026-12-03', -148000, GADGETS, { isOneOff: true });
  // CBA Female Saver
  await addTx('CBA Female Saver', 's1', '2026-09-15', 20000, INTERNAL);
  await addTx('CBA Female Saver', 's2', '2026-09-30', 1000, INTEREST);
  await addTx('CBA Female Saver', 's3', '2026-10-15', 20000, INTERNAL);
  await addTx('CBA Female Saver', 's4', '2026-10-31', 1000, INTEREST);
  await addTx('CBA Female Saver', 's5', '2026-11-15', 20000, INTERNAL);
  await addTx('CBA Female Saver', 's6', '2026-11-30', 1000, INTEREST);
  await addTx('CBA Female Saver', 's7', '2026-12-10', 1234, INTEREST);
  // ANZ Card
  await addTx('ANZ Card', 'c1', '2026-11-20', -20000, CLOTHING);
  await addTx('ANZ Card', 'c2', '2026-12-02', -5000, SUPERMARKET, { isOneOff: false });
  // ANZ Joint：j1、j2 在一次 CSV 导入里（撤销导入用）
  jointBatchId = await batch('ANZ Joint', 'csv', '2026-11-28', null);
  await addTx('ANZ Joint', 'j1', '2026-11-18', -150000, HOLIDAYS, {
    isOneOff: true,
    batchId: jointBatchId,
  });
  await addTx('ANZ Joint', 'j2', '2026-11-28', 10000, HOLIDAYS, {
    isOneOff: true,
    batchId: jointBatchId,
  });
  // ANZ Old（已归档）
  await addTx('ANZ Old', 'o1', '2026-09-20', 100000, INCOME_OTHER);

  // 补数（ANZ Joint，不是一次性）：最早一笔 2026-01-08；1 到 8 月支出 3180000；
  // 9 到 11 月收入补到 600000，支出补到 420000、380000、740000（11 月含一次性 320000）
  await addTx('ANZ Joint', 'fill-01', '2026-01-08', -3180000, SUPERMARKET);
  await addTx('ANZ Joint', 'inc-09', '2026-09-05', 399000, SALARY); // + n1、s2、o1
  await addTx('ANZ Joint', 'inc-10', '2026-10-05', 499000, SALARY); // + n4、s4
  await addTx('ANZ Joint', 'inc-11', '2026-11-05', 247000, SALARY); // + n7、f3、s6、p4
  await addTx('ANZ Joint', 'exp-09', '2026-09-20', -420000, SUPERMARKET);
  await addTx('ANZ Joint', 'exp-10', '2026-10-20', -380000, SUPERMARKET);
  await addTx('ANZ Joint', 'exp-11', '2026-11-20', -400000, SUPERMARKET); // + c1、f1、j1、j2

  await insertGoals();
  await setGoalOnSplit('f1', 'G10', true);
  await setGoalOnSplit('j1', 'G10', true);
  await setGoalOnSplit('j2', 'G10', true);
  await setGoalOnSplit('f2', 'G7', true);
}

// ---------- 读结果 ----------

function activeOf(o: GoalsOverview, key: string): ActiveGoal {
  const id = goalId(key);
  const g = o.emergency?.id === id ? o.emergency : o.active.find((x) => x.id === id);
  if (!g) throw new Error(`active 里没有 ${key}`);
  return g;
}

const overview = () => getGoals(t.ctx, TODAY);

// 新建用的输入：spend / once、金额 10000、不挂账户（场景 I）
function input(overrides: Partial<GoalInput> = {}): GoalInput {
  return {
    name: '新目标',
    kind: 'spend',
    recurrence: 'once',
    targetCents: 10000,
    targetDate: null,
    accountId: null,
    emergencyMonths: null,
    isPinned: false,
    ...overrides,
  };
}

async function goalRow(key: string) {
  const [row] = await db
    .select()
    .from(schema.goal)
    .where(eq(schema.goal.id, goalId(key)));
  return row;
}

async function nextOf(key: string) {
  const [row] = await db
    .select()
    .from(schema.goal)
    .where(
      and(eq(schema.goal.householdId, t.ctx.householdId), eq(schema.goal.prevGoalId, goalId(key))),
    );
  return row;
}

describeDb('M11-4 目标和应急金（R25）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    await insertBase();
  });

  // ---------- getGoals ----------

  it('R25.3 B-1: progress filled by priority per account', async () => {
    const o = await overview();
    const p = (key: string) => activeOf(o, key).progress;
    expect(p('G1')).toMatchObject({ filledCents: 500000, remainingCents: 0, reached: true });
    expect(p('G2')).toMatchObject({ filledCents: 200000, remainingCents: 200000, reached: false });
    expect(p('E')).toMatchObject({
      targetCents: 2400000,
      filledCents: 1559000,
      remainingCents: 841000,
    });
    expect(p('G3')).toMatchObject({ filledCents: 0, remainingCents: 5000000 });
    expect(p('G4')).toMatchObject({ filledCents: 0, remainingCents: 150000 });
    expect(p('G5')).toMatchObject({ filledCents: 50000, remainingCents: 30000 });
    expect(p('G6')).toMatchObject({ filledCents: 100000, remainingCents: 0, reached: true });
    expect(p('G8')).toMatchObject({ filledCents: 200000, remainingCents: 50000 });
    expect(p('G11')).toMatchObject({
      filledCents: null,
      remainingCents: 200000,
      noProgress: 'no_balance',
    });
    expect(p('G12')).toMatchObject({
      filledCents: null,
      remainingCents: 50000,
      noProgress: 'archived',
    });
    for (const key of ['G9', 'G10', 'G13']) {
      expect(p(key)).toMatchObject({ filledCents: null, noProgress: 'no_account' });
    }
  });

  it('R25.2 A-1: monthly required, overdue G10, total 222263', async () => {
    const o = await overview();
    const required = Object.fromEntries(
      [...o.active, o.emergency!].map((g) => [
        GOALS.find(([k]) => goalId(k) === g.id)![0],
        g.monthlyRequiredCents,
      ]),
    );
    expect(required).toEqual({
      E: null,
      G1: 0,
      G2: 33334,
      G3: null,
      G4: 30000,
      G5: 10000,
      G6: 0,
      G8: 12500,
      G9: 60000,
      G10: null,
      G11: 25000,
      G12: 50000,
      G13: 1429,
    });
    expect(activeOf(o, 'G10')).toMatchObject({
      overdue: true,
      progress: { remainingCents: 300000 },
    });
    expect(activeOf(o, 'G9').overdue).toBe(false);
    expect(o.affordability.requiredTotalCents).toBe(222263);
  });

  it('R25.4 C-1: projected completion', async () => {
    const o = await overview();
    const proj = (key: string) => activeOf(o, key).projection;
    expect(proj('E')).toEqual({ kind: 'projected', month: '2030-05', lateMonths: null });
    expect(proj('G3')).toEqual({ kind: 'projected', month: '2050-03', lateMonths: null });
    expect(proj('G1')).toEqual({ kind: 'reached' });
    expect(proj('G2')).toEqual({ kind: 'projected', month: '2027-07', lateMonths: 1 });
    expect(proj('G4')).toEqual({ kind: 'unreachable' });
    expect(proj('G5')).toEqual({ kind: 'unreachable' });
    expect(proj('G6')).toEqual({ kind: 'reached' });
    expect(proj('G8')).toEqual({ kind: 'projected', month: '2027-01', lateMonths: 0 });
    expect(proj('G9')).toEqual({ kind: 'no_progress', reason: 'no_account' });
    expect(proj('G11')).toEqual({ kind: 'no_progress', reason: 'no_balance' });
    expect(proj('G12')).toEqual({ kind: 'no_progress', reason: 'archived' });
  });

  it('R25.5 D-1: actual savings excludes goal-linked splits → 193333, short', async () => {
    const o = await overview();
    expect(o.affordability).toEqual({
      requiredTotalCents: 222263,
      actualCents: 193333,
      short: true,
      months: 3,
    });
  });

  it('R25.6 E-1: emergency target = 400000 × 6, covers 3.8 months', async () => {
    const e = (await overview()).emergency!;
    expect(e.id).toBe(goalId('E'));
    expect(e.average?.totalCents).toBe(400000);
    expect(e.average?.months).toBe(11);
    expect(e.progress.targetCents).toBe(2400000);
    expect(e.monthsCoveredTenths).toBe(38);
  });

  it('R25.7 F-1: plan and actual; G7 is in done', async () => {
    const o = await overview();
    expect(activeOf(o, 'G10').spend).toEqual({
      planCents: 300000,
      actualCents: 320000,
      diffCents: 20000,
      count: 3,
    });
    expect(activeOf(o, 'G10').linked.map((s) => s.merchant)).toEqual(['f1', 'j1', 'j2']);
    expect(activeOf(o, 'G1').spend).toMatchObject({ actualCents: 0, count: 0 });
    expect(activeOf(o, 'G3').spend).toBeNull(); // keep
    expect(o.done.map((g) => g.id)).toEqual([goalId('G7')]);
    expect(o.done[0].spend).toEqual({
      planCents: 150000,
      actualCents: 148000,
      diffCents: -2000,
      count: 1,
    });
  });

  it('R25.11 J-1: active list is by priority without E and G7', async () => {
    const o = await overview();
    const keys = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13'];
    expect(o.active.map((g) => g.id)).toEqual(keys.map(goalId));
  });

  it('R25.10 H: budget spendable = monthly required total, same as getGoals', async () => {
    expect(await getBudgetSpendable(t.ctx, TODAY)).toBe(222263);
  });

  it('R25.10 H: only G2 left with a monthly amount → 33334; D-5 → 0', async () => {
    // G1、G6 已存够（0），G10 已过期，都不进合计；删掉其他有每月要存的
    for (const key of ['G4', 'G5', 'G8', 'G9', 'G11', 'G12', 'G13']) {
      await db.delete(schema.goal).where(eq(schema.goal.id, goalId(key)));
    }
    expect(await getBudgetSpendable(t.ctx, TODAY)).toBe(33334);
    expect((await overview()).affordability.requiredTotalCents).toBe(33334);

    // D-5：再删 G2，剩 E、G1、G3、G6、G10 → 0
    await db.delete(schema.goal).where(eq(schema.goal.id, goalId('G2')));
    expect(await getBudgetSpendable(t.ctx, TODAY)).toBe(0);
  });

  it('R25.10: emergency on the same account as a dated goal still takes money first', async () => {
    // G3 改成有日期：Saver 1559000 先给 E（2400000），G3 是 0，还差 5000000，2027-12 → 12 个月
    await db
      .update(schema.goal)
      .set({ targetDate: '2027-12-01' })
      .where(eq(schema.goal.id, goalId('G3')));
    const o = await overview();
    expect(activeOf(o, 'G3').monthlyRequiredCents).toBe(Math.ceil(5000000 / 12));
    expect(await getBudgetSpendable(t.ctx, TODAY)).toBe(o.affordability.requiredTotalCents);
  });

  // ---------- 挂交易 ----------

  it('R25.7 F-4: link validation, other household goal not found', async () => {
    expect(await linkSplitToGoal(t.ctx, splitOf('p5'), goalId('G1'))).toEqual({
      ok: false,
      message: '只有支出能挂到目标',
    });
    expect(await linkSplitToGoal(t.ctx, splitOf('f3'), goalId('G1'))).toMatchObject({
      message: '只有支出能挂到目标',
    });
    expect(await linkSplitToGoal(t.ctx, splitOf('c1'), goalId('G3'))).toMatchObject({
      message: '只能挂到要花掉的目标',
    });
    expect(await linkSplitToGoal(t.ctx, splitOf('c1'), goalId('E'))).toMatchObject({
      message: '只能挂到要花掉的目标',
    });
    expect(await linkSplitToGoal(t.ctx, splitOf('c1'), goalId('G7'))).toMatchObject({
      message: '目标已经完成，不能再挂',
    });
    expect(await linkSplitToGoal(t.ctx, splitOf('c1'), goalId('Other'))).toMatchObject({
      message: '找不到这个目标',
    });
    expect((await splitRow('c1')).goalId).toBeNull();
    expect(await linkSplitToGoal(t.ctx, splitOf('c1'), goalId('G12'))).toEqual({ ok: true });
  });

  it('R25.7: another household cannot link our split', async () => {
    const other = { ...t.ctx, householdId: (await goalRowOther()).householdId };
    expect(await linkSplitToGoal(other, splitOf('c1'), goalId('Other'))).toEqual({
      ok: false,
      message: '找不到这笔交易',
    });
  });

  it('R25.7 F-2: link sets is_one_off true, relink keeps it, unlink does not touch it', async () => {
    expect(await linkSplitToGoal(t.ctx, splitOf('c2'), goalId('G4'))).toEqual({ ok: true });
    expect(await splitRow('c2')).toMatchObject({ goalId: goalId('G4'), isOneOff: true });
    expect(activeOf(await overview(), 'G4').spend?.actualCents).toBe(5000);

    await linkSplitToGoal(t.ctx, splitOf('c2'), goalId('G2'));
    const o = await overview();
    expect(activeOf(o, 'G4').spend?.actualCents).toBe(0);
    expect(activeOf(o, 'G2').spend?.actualCents).toBe(5000);
    expect(o.emergency?.average?.totalCents).toBe(400000); // 12 月不在窗口里

    await linkSplitToGoal(t.ctx, splitOf('c2'), null);
    expect(await splitRow('c2')).toMatchObject({ goalId: null, isOneOff: true });
  });

  it('R25.7 F-3 / E-3: linking f1, j1, j2 to G10 changes the average and actual savings', async () => {
    for (const name of ['f1', 'j1', 'j2']) await setGoalOnSplit(name, null, null);
    let o = await overview();
    expect(o.emergency?.average?.totalCents).toBe(429091);
    expect(o.emergency?.progress.targetCents).toBe(2574546);
    expect(o.emergency?.monthsCoveredTenths).toBe(36);
    expect(o.affordability.actualCents).toBe(86667);

    for (const name of ['f1', 'j1', 'j2']) {
      expect(await linkSplitToGoal(t.ctx, splitOf(name), goalId('G10'))).toEqual({ ok: true });
      expect((await splitRow(name)).isOneOff).toBe(true);
    }
    o = await overview();
    expect(o.emergency?.average?.totalCents).toBe(400000);
    expect(o.emergency?.progress.targetCents).toBe(2400000);
    expect(o.affordability.actualCents).toBe(193333);
  });

  it('R25.7 F-6: unlink from a done goal', async () => {
    expect(await linkSplitToGoal(t.ctx, splitOf('f2'), null)).toEqual({ ok: true });
    const o = await overview();
    expect(o.done[0].spend).toEqual({
      planCents: 150000,
      actualCents: 0,
      diffCents: -150000,
      count: 0,
    });
    expect((await splitRow('f2')).isOneOff).toBe(true);
  });

  // ---------- R25.8 goal_id 怎么变 ----------

  it('R25.8 F-5: f1 to another expense category keeps goal_id and one-off', async () => {
    const r = await updateSplitCategory(t.ctx, splitOf('f1'), t.h.category(SUPERMARKET).id);
    expect(r.ok).toBe(true);
    expect(await splitRow('f1')).toMatchObject({ goalId: goalId('G10'), isOneOff: true });
    expect(activeOf(await overview(), 'G10').spend?.actualCents).toBe(320000);
  });

  it('R25.8 F-5: f1 to Income / Other clears goal_id and one-off', async () => {
    const r = await updateSplitCategory(t.ctx, splitOf('f1'), t.h.category(INCOME_OTHER).id);
    expect(r.ok).toBe(true);
    expect(await splitRow('f1')).toMatchObject({ goalId: null, isOneOff: null });
    expect(activeOf(await overview(), 'G10').spend).toMatchObject({
      actualCents: 140000,
      diffCents: -160000,
    });
  });

  it('R25.8 F-5: j1 redetected as internal transfer (R6.4) clears goal_id and one-off', async () => {
    const female = t.h.account('CBA Female');
    await db
      .update(schema.financialAccount)
      .set({ numberSuffix: null })
      .where(eq(schema.financialAccount.id, female.id));
    await db
      .update(schema.transaction)
      .set({
        rawDescription: maskLongDigits(
          'ANZ M-BANKING FUNDS TFER TRANSFER 100002  TO  012345400000003',
        ),
      })
      .where(eq(schema.transaction.id, txIds.get('j1')!));
    await db
      .update(schema.transactionSplit)
      .set({ categorySource: 'rule' })
      .where(eq(schema.transactionSplit.id, splitOf('j1')));

    const r = await updateAccount(
      t.ctx,
      female.id,
      {
        name: female.name,
        bank: female.bank,
        type: female.type,
        defaultMemberId: female.defaultMemberId,
        numberSuffix: '0003',
      },
      { redetect: true },
    );
    expect(r.redetectedCount).toBe(1);
    expect(await splitRow('j1')).toMatchObject({
      categoryId: t.h.systemCategory('internal_transfer').id,
      goalId: null,
      isOneOff: null,
    });
    expect(activeOf(await overview(), 'G10').spend?.actualCents).toBe(170000);
  });

  it('R25.8 F-5: split off part of j1 → new split null, primary keeps G10', async () => {
    const r = await addSplit(t.ctx, txIds.get('j1')!, {
      amountCents: 50000,
      categoryId: t.h.category(SUPERMARKET).id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [created] = await db
      .select()
      .from(schema.transactionSplit)
      .where(eq(schema.transactionSplit.id, r.splitId));
    expect(created).toMatchObject({ amountCents: -50000, goalId: null, isOneOff: null });
    expect(await splitRow('j1')).toMatchObject({
      amountCents: -100000,
      goalId: goalId('G10'),
      isOneOff: true,
    });
    expect(activeOf(await overview(), 'G10').spend).toMatchObject({
      actualCents: 270000,
      diffCents: -30000,
    });
  });

  it('R25.8 F-5: undo the import of j1, j2 → linked splits gone, actual follows', async () => {
    const r = await undoImport(t.ctx, jointBatchId);
    expect(r.ok).toBe(true);
    expect(activeOf(await overview(), 'G10').spend).toMatchObject({
      actualCents: 180000,
      diffCents: -120000,
      count: 1,
    });
  });

  // ---------- R25.9 完成、撤销完成、删除、改优先级 ----------

  it('R25.9 G-2: completing yearly G5 creates the next cycle', async () => {
    const r = await completeGoal(t.ctx, goalId('G5'));
    expect(r.ok).toBe(true);
    expect(await goalRow('G5')).toMatchObject({ status: 'done' });
    expect((await goalRow('G5')).doneAt).not.toBeNull();
    const next = await nextOf('G5');
    expect(r).toEqual({ ok: true, goalId: next.id });
    expect(next).toMatchObject({
      name: 'rego',
      kind: 'spend',
      recurrence: 'yearly',
      targetCents: 80000,
      targetDate: '2028-03-15',
      accountId: accountId('ANZ Male'),
      priority: 5,
      status: 'active',
      doneAt: null,
    });
    const o = await overview();
    const g = o.active.find((x) => x.id === next.id)!;
    expect(g.progress).toMatchObject({ filledCents: 50000, remainingCents: 30000 });
    expect(g.monthlyRequiredCents).toBe(2000);
    expect(o.affordability.requiredTotalCents).toBe(214263);
  });

  it('R25.9 G-3, G-4: Feb 29 → Feb 28; reopening deletes the unlinked next cycle', async () => {
    await completeGoal(t.ctx, goalId('G13'));
    const next = await nextOf('G13');
    expect(next.targetDate).toBe('2029-02-28');
    expect((await overview()).active.find((x) => x.id === next.id)?.monthlyRequiredCents).toBe(770);

    expect(await reopenGoal(t.ctx, goalId('G13'))).toEqual({ ok: true, goalId: goalId('G13') });
    expect(await nextOf('G13')).toBeUndefined();
    expect(await goalRow('G13')).toMatchObject({
      status: 'active',
      doneAt: null,
      targetDate: '2028-02-29',
      priority: 13,
    });
  });

  it('R25.9 G-5: reopening fails when the next cycle has a link or is done', async () => {
    await completeGoal(t.ctx, goalId('G5'));
    const next = await nextOf('G5');
    await linkSplitToGoal(t.ctx, splitOf('c1'), next.id);
    expect(await reopenGoal(t.ctx, goalId('G5'))).toMatchObject({
      ok: false,
      message: '下一期已经挂了交易，不能撤销',
    });
    expect((await goalRow('G5')).status).toBe('done');

    await linkSplitToGoal(t.ctx, splitOf('c1'), null);
    await completeGoal(t.ctx, next.id);
    expect(await reopenGoal(t.ctx, goalId('G5'))).toMatchObject({
      ok: false,
      message: '下一期已经完成了，先撤销下一期',
    });
  });

  it('R25.9 G-6, G-1: reopen once G7 → B-4; complete again → B-1', async () => {
    expect(await reopenGoal(t.ctx, goalId('G7'))).toEqual({ ok: true, goalId: goalId('G7') });
    let o = await overview();
    expect(activeOf(o, 'G7').progress).toMatchObject({ filledCents: 150000, remainingCents: 0 });
    expect(activeOf(o, 'G8')).toMatchObject({
      progress: { filledCents: 50000, remainingCents: 200000 },
      monthlyRequiredCents: 50000,
    });

    await completeGoal(t.ctx, goalId('G7'));
    o = await overview();
    expect(activeOf(o, 'G8')).toMatchObject({
      progress: { filledCents: 200000 },
      monthlyRequiredCents: 12500,
    });
    expect(o.done[0]).toMatchObject({ id: goalId('G7'), spend: { actualCents: 148000 } });
  });

  it('R25.9 G-6: reopen fails when an active goal has the same name', async () => {
    expect((await createGoal(t.ctx, { ...input({ name: '相机' }), isEmergency: false })).ok).toBe(
      true,
    );
    expect(await reopenGoal(t.ctx, goalId('G7'))).toMatchObject({
      ok: false,
      message: '已有同名的目标，先改名',
    });
    expect((await goalRow('G7')).status).toBe('done');
  });

  it('R25.6 E-6: emergency cannot be completed', async () => {
    expect(await completeGoal(t.ctx, goalId('E'))).toMatchObject({ ok: false });
    expect((await goalRow('E')).status).toBe('active');
  });

  it('R25.9 G-7: delete', async () => {
    const linked = { ok: false, field: 'form', message: '挂了交易的目标不能删，可以点完成' };
    expect(await deleteGoal(t.ctx, goalId('G10'))).toEqual(linked);
    expect(await deleteGoal(t.ctx, goalId('G7'))).toEqual(linked);
    expect(await deleteGoal(t.ctx, goalId('G9'))).toEqual({ ok: true, goalId: goalId('G9') });
    expect(await deleteGoal(t.ctx, goalId('E'))).toMatchObject({ ok: true });
    expect(activeOf(await overview(), 'G3').progress.filledCents).toBe(1559000);

    await completeGoal(t.ctx, goalId('G5'));
    const next = await nextOf('G5');
    expect(await deleteGoal(t.ctx, goalId('G5'))).toMatchObject({ ok: true });
    const [row] = await db.select().from(schema.goal).where(eq(schema.goal.id, next.id));
    expect(row.prevGoalId).toBeNull();
    // 别的家庭的目标删不了
    expect(await deleteGoal(t.ctx, goalId('Other'))).toMatchObject({
      ok: false,
      message: '找不到这个目标',
    });
  });

  it('R25.9 B-5: move G2 up; G1 cannot move up, G13 cannot move down', async () => {
    expect(await moveGoal(t.ctx, goalId('G1'), 'up')).toMatchObject({ ok: false });
    expect(await moveGoal(t.ctx, goalId('G13'), 'down')).toMatchObject({ ok: false });
    expect(await moveGoal(t.ctx, goalId('E'), 'down')).toMatchObject({ ok: false });

    expect(await moveGoal(t.ctx, goalId('G2'), 'up')).toEqual({ ok: true, goalId: goalId('G2') });
    expect((await goalRow('G2')).priority).toBe(1);
    expect((await goalRow('G1')).priority).toBe(2);
    const o = await overview();
    expect(activeOf(o, 'G2')).toMatchObject({
      progress: { filledCents: 400000 },
      monthlyRequiredCents: 0,
    });
    expect(activeOf(o, 'G1')).toMatchObject({
      progress: { filledCents: 300000, remainingCents: 200000 },
      monthlyRequiredCents: 66667,
    });
  });

  // ---------- R25.1 校验 ----------

  it('R25.1 I: name checks, priority of the first new goal is 14', async () => {
    const create = (o: Partial<GoalInput>) =>
      createGoal(t.ctx, { ...input(o), isEmergency: false });
    expect(await create({ name: '   ' })).toMatchObject({ field: 'name', message: '请填名字' });
    expect(await create({ name: '字'.repeat(51) })).toMatchObject({ message: '名字最多 50 个字' });
    expect(await create({ name: '  旅行 ' })).toMatchObject({ message: '已有同名的目标' });
    expect(await create({ name: 'REGO' })).toMatchObject({ message: '已有同名的目标' });

    const r = await create({ name: '相机' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [row] = await db.select().from(schema.goal).where(eq(schema.goal.id, r.goalId));
    expect(row).toMatchObject({
      name: '相机',
      priority: 14,
      status: 'active',
      createdBy: t.ctx.userId,
    });
  });

  it('R25.1 I: amount, recurrence, date, emergency checks', async () => {
    const create = (o: Partial<GoalInput>, isEmergency = false) =>
      createGoal(t.ctx, { ...input(o), isEmergency });
    expect(await create({ targetCents: 0 })).toMatchObject({ message: '目标金额要大于 0' });
    expect(
      await create({ kind: 'keep', recurrence: 'yearly', targetDate: '2027-01-01' }),
    ).toMatchObject({
      message: '只有要花掉的目标能每年重复',
    });
    expect(await create({ recurrence: 'yearly' })).toMatchObject({
      message: '每年重复的目标要填日期',
    });
    expect(await create({ name: '应急金 2', emergencyMonths: 6 }, true)).toMatchObject({
      message: '已经有应急金目标了',
    });
    expect((await create({ name: '过期的', targetDate: '2026-01-01' })).ok).toBe(true);

    const e = (months: number) =>
      updateGoal(
        t.ctx,
        goalId('E'),
        input({
          name: '应急金',
          emergencyMonths: months,
          accountId: accountId('CBA Female Saver'),
        }),
      );
    for (const m of [0, 25, 2.5]) expect(await e(m)).toMatchObject({ message: '月数是 1 到 24' });
    for (const m of [1, 24]) expect((await e(m)).ok).toBe(true);
    expect(await goalRow('E')).toMatchObject({
      emergencyMonths: 24,
      kind: 'keep',
      targetCents: null,
    });
  });

  it('R25.1 I: account checks only when the account changes', async () => {
    const create = (account: string) =>
      createGoal(t.ctx, {
        ...input({ name: account, accountId: accountId(account) }),
        isEmergency: false,
      });
    expect(await create('Other ANZ')).toMatchObject({
      field: 'accountId',
      message: '找不到这个账户',
    });
    expect(await create('ANZ Old')).toMatchObject({ message: '不能挂已归档的账户' });
    expect(await create('现金（Female）')).toMatchObject({ message: '不能挂现金账户' });
    expect((await create('Westpac 中转')).ok).toBe(true);

    // G12 还挂着 ANZ Old，只改金额 → 不校验账户
    const g12 = input({
      name: '婚礼礼金',
      targetCents: 60000,
      targetDate: '2027-01-20',
      accountId: accountId('ANZ Old'),
    });
    expect((await updateGoal(t.ctx, goalId('G12'), g12)).ok).toBe(true);
    // G1 名字不变 → 自己不算重名
    const g1 = input({
      name: '包',
      targetCents: 500000,
      targetDate: '2027-03-20',
      accountId: accountId('ANZ Plus Male'),
    });
    expect((await updateGoal(t.ctx, goalId('G1'), g1)).ok).toBe(true);
    // 别的家庭的目标改不了
    expect(await updateGoal(t.ctx, goalId('Other'), input())).toMatchObject({
      message: '找不到这个目标',
    });
  });

  it('R25.1: done goals cannot be edited; spend with links cannot become keep', async () => {
    expect(await updateGoal(t.ctx, goalId('G7'), input({ name: '相机' }))).toMatchObject({
      message: '已完成的目标不能改，先撤销完成',
    });
    const g10 = input({
      name: '日本旅行',
      kind: 'keep',
      targetCents: 300000,
      targetDate: '2026-11-30',
    });
    expect(await updateGoal(t.ctx, goalId('G10'), g10)).toMatchObject({
      message: '挂了交易的目标不能改成存着的',
    });
  });
});

async function goalRowOther() {
  const [row] = await db
    .select()
    .from(schema.goal)
    .where(eq(schema.goal.id, goalId('Other')));
  return row;
}
