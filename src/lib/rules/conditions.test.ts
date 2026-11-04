import { describe, expect, it } from 'vitest';
import type { BalanceAnchor } from './balance';
import {
  CONDITION_REMINDER_DAYS,
  MONTH_CELL_LABELS,
  asOfLabel,
  countableDeposits,
  dataAsOf,
  describeCondition,
  evaluateCondition,
  feeMismatch,
  feeMismatchText,
  homeReminder,
  inReminderWindow,
  isJudgedIn,
  monthsForHistory,
  outcomeSummaryText,
  resolveCounterparty,
  summarizeAccountMonth,
  unknownDepositNote,
  type ConditionAccount,
  type ConditionPeriod,
  type ConditionTx,
  type ManualCheck,
  type MonthlyCondition,
} from './conditions';
import type { Account } from './types';

// 期望值来自 docs/rules/R24-monthly-condition.md 和 fixtures/cases/15-monthly-conditions.md
// 今天默认 2026-12-28

const TODAY = '2026-12-28';

// ---------- 账户 ----------

const JOINT = 'joint';
const MALE = 'male';
const FEMALE = 'female';
const SAVER = 'saver';
const PLUS = 'plus';
const WESTPAC = 'westpac';

type AccountSeed = { id: string; name: string; linkedAccountId: string | null; anchorDate: string | null };

const BASE_ACCOUNTS: AccountSeed[] = [
  { id: JOINT, name: 'ANZ Joint', linkedAccountId: null, anchorDate: null },
  { id: MALE, name: 'ANZ Male', linkedAccountId: null, anchorDate: null },
  { id: FEMALE, name: 'CBA Female', linkedAccountId: null, anchorDate: null },
  { id: SAVER, name: 'CBA Female Saver', linkedAccountId: FEMALE, anchorDate: '2026-11-30' },
  { id: PLUS, name: 'ANZ Plus Male', linkedAccountId: MALE, anchorDate: '2026-11-30' },
  { id: WESTPAC, name: 'Westpac 中转', linkedAccountId: null, anchorDate: '2026-11-30' },
];

// resolveCounterparty 用的家庭账户（R6.1 尾号）
const bankAccount = (id: string, name: string, bank: Account['bank'], numberSuffix: string): Account => ({
  id,
  name,
  bank,
  type: 'everyday',
  defaultMemberId: 'm',
  numberSuffix,
});
const BANK_ACCOUNTS: Account[] = [
  bankAccount(JOINT, 'ANZ Joint', 'anz', '0001'),
  bankAccount(MALE, 'ANZ Male', 'anz', '0002'),
  bankAccount(FEMALE, 'CBA Female', 'cba', '0003'),
  bankAccount(SAVER, 'CBA Female Saver', 'cba', '7777'),
  bankAccount(PLUS, 'ANZ Plus Male', 'anz_plus', '0004'),
];

// ---------- 交易 ----------

type TxOpts = Partial<Pick<ConditionTx, 'status' | 'transferStatus' | 'counterpartyAccountId' | 'merchant'>> & {
  split?: 'fee' | 'interest'; // 整笔拆分是 Bank fees 或 Income / Interest
};
let seq = 0;
const tx = (id: string, accountId: string, date: string, amountCents: number, opts: TxOpts = {}): ConditionTx => ({
  id,
  accountId,
  date,
  amountCents,
  status: opts.status ?? 'confirmed',
  transferStatus: opts.transferStatus ?? 'none',
  counterpartyAccountId: opts.counterpartyAccountId ?? null,
  bankFeeCents: opts.split === 'fee' ? amountCents : 0,
  interestCents: opts.split === 'interest' ? amountCents : 0,
  merchant: opts.merchant ?? null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)),
});
const fee: TxOpts = { split: 'fee' };
const interest: TxOpts = { split: 'interest' };
const auto = (counterpartyAccountId: string): TxOpts => ({ transferStatus: 'auto', counterpartyAccountId });

const BASE_TXS: ConditionTx[] = [
  // ANZ Joint
  tx('j0', JOINT, '2026-08-20', 300000),
  tx('j1', JOINT, '2026-09-15', 160000),
  tx('j2', JOINT, '2026-10-01', 200000),
  tx('j3', JOINT, '2026-10-30', -500, fee),
  tx('j4', JOINT, '2026-10-30', 500, fee),
  tx('j5', JOINT, '2026-11-02', 199600),
  tx('j6', JOINT, '2026-11-30', -500, fee),
  tx('j7', JOINT, '2026-11-30', 500, fee),
  tx('j8', JOINT, '2026-12-01', 150000),
  tx('j9', JOINT, '2026-12-05', 2312, interest),
  tx('j10', JOINT, '2026-12-08', 1999),
  tx('j11', JOINT, '2026-12-10', -5000),
  tx('j12', JOINT, '2026-12-12', 30000, auto(MALE)),
  tx('j13', JOINT, '2026-12-16', 10000, auto(PLUS)),
  tx('j14', JOINT, '2026-12-20', -4321),
  tx('j15', JOINT, '2026-12-27', 8000, { status: 'pending' }),
  // ANZ Male
  tx('n1', MALE, '2026-11-05', 100000),
  tx('n2', MALE, '2026-11-10', -50000, auto(PLUS)),
  tx('n3', MALE, '2026-11-30', -500, fee),
  tx('m1', MALE, '2026-12-01', -500, fee),
  tx('m2', MALE, '2026-12-02', 120000, auto(PLUS)),
  tx('m3', MALE, '2026-12-09', 30000),
  tx('m4', MALE, '2026-12-12', -30000, auto(JOINT)),
  tx('m5', MALE, '2026-12-15', 50000, auto(FEMALE)),
  // ANZ Plus Male
  tx('p1', PLUS, '2026-11-10', 50000, auto(MALE)),
  tx('p2', PLUS, '2026-11-30', 2500, interest),
  // CBA Female Saver
  tx('s1', SAVER, '2026-11-30', 900, interest),
  tx('s2', SAVER, '2026-12-06', 50000, auto(FEMALE)),
  tx('s3', SAVER, '2026-12-10', 120, interest),
  tx('s4', SAVER, '2026-12-15', -120, interest),
  tx('s5', SAVER, '2026-12-16', -500, fee),
  // CBA Female
  tx('f1', FEMALE, '2026-12-02', -4500),
  tx('f2', FEMALE, '2026-12-04', -1200),
  tx('f3', FEMALE, '2026-12-06', -50000, auto(SAVER)),
  tx('f4', FEMALE, '2026-12-08', -2000, { transferStatus: 'suggested' }),
  tx('f5', FEMALE, '2026-12-10', -600, fee),
  tx('f6', FEMALE, '2026-12-12', -3300),
  tx('f7', FEMALE, '2026-12-14', -50000, auto(MALE)),
  tx('f8', FEMALE, '2026-12-18', 1500),
  tx('f9', FEMALE, '2026-12-20', -800, { status: 'pending' }),
  tx('f10', FEMALE, '2026-12-22', -2100),
];

// 变体
const J16_ENOUGH = tx('j16', JOINT, '2026-12-28', 8001);
const J16_SHORT = tx('j16', JOINT, '2026-12-28', 8000);
const V_S1 = [
  tx('s6', SAVER, '2026-12-03', -20000, auto(FEMALE)),
  tx('f11', FEMALE, '2026-12-03', 20000, auto(SAVER)),
];
const V_S2 = [tx('s7', SAVER, '2026-12-20', -3000, { merchant: 'CBA ATM' })];
const V_F1 = BASE_TXS.map((t) => (t.id === 'f9' ? { ...t, status: 'confirmed' as const } : t));

// 截至按 R24.6 从交易和锚点算出来
function accountsFor(
  txs: readonly ConditionTx[],
  overrides: Partial<Record<string, Partial<AccountSeed>>> = {},
): ConditionAccount[] {
  return BASE_ACCOUNTS.map((seed) => {
    const a = { ...seed, ...overrides[seed.id] };
    return {
      id: a.id,
      name: a.name,
      linkedAccountId: a.linkedAccountId,
      archived: false,
      asOf: dataAsOf(
        a.anchorDate,
        txs.filter((t) => t.accountId === a.id),
      ),
    };
  });
}

// ---------- 条件 ----------

const cond = <T extends MonthlyCondition>(c: T): T => c;
const K1 = cond({ id: 'K1', accountId: JOINT, outcome: 'fee_waiver', type: 'min_deposit', amountCents: 150000, depositFilter: 'any' });
const K2 = cond({ id: 'K2', accountId: JOINT, outcome: 'fee_waiver', type: 'min_deposit', amountCents: 200000, depositFilter: 'any' });
const K13 = cond({ id: 'K13', accountId: JOINT, outcome: 'bonus', type: 'min_deposit', amountCents: 50000, depositFilter: 'any' });
const K3 = cond({ id: 'K3', accountId: MALE, outcome: 'fee_waiver', type: 'min_deposit', amountCents: 100000, depositFilter: 'exclude_linked' });
const K5 = cond({ id: 'K5', accountId: PLUS, outcome: 'bonus', type: 'linked_min_deposit', amountCents: 100000, depositFilter: 'exclude_linked' });
const K6 = cond({ id: 'K6', accountId: SAVER, outcome: 'bonus', type: 'no_withdrawal' });
const K8 = cond({ id: 'K8', accountId: SAVER, outcome: 'bonus', type: 'linked_card_count', cardCount: 5 });
const K10 = cond({ id: 'K10', accountId: WESTPAC, outcome: 'bonus', type: 'linked_card_count', cardCount: 3 });
const K4 = cond({ id: 'K4', accountId: PLUS, outcome: 'bonus', type: 'balance_growth' });
const K7 = cond({ id: 'K7', accountId: SAVER, outcome: 'bonus', type: 'balance_growth' });
const K9 = cond({ id: 'K9', accountId: FEMALE, outcome: 'fee_waiver', type: 'other', description: '每月登录一次网银' });

// 生效月份（R24.1）。K11（归档）、K12（别的家庭）由数据层筛掉，这里不放
const PERIODS: Record<string, ConditionPeriod> = {
  K1: { effectiveFrom: '2026-09-01', disabledFrom: '2026-10-01' },
  K2: { effectiveFrom: '2026-10-01', disabledFrom: null },
  K13: { effectiveFrom: '2026-11-01', disabledFrom: '2026-12-01' },
  K3: { effectiveFrom: '2026-11-01', disabledFrom: null },
  K4: { effectiveFrom: '2026-11-01', disabledFrom: null },
  K5: { effectiveFrom: '2026-11-01', disabledFrom: null },
  K6: { effectiveFrom: '2026-11-01', disabledFrom: null },
  K7: { effectiveFrom: '2026-11-01', disabledFrom: null },
  K8: { effectiveFrom: '2026-12-01', disabledFrom: null },
  K9: { effectiveFrom: '2026-11-01', disabledFrom: null },
  K10: { effectiveFrom: '2026-12-01', disabledFrom: null },
};
const ALL_CONDITIONS: MonthlyCondition[] = [K1, K2, K13, K3, K4, K5, K6, K7, K8, K9, K10];

// K9 的手动勾（R24.7）：11 月满足了，12 月还没勾
const BASE_CHECKS: Record<string, ManualCheck> = { 'K9 2026-11-01': 'met' };

// ---------- 锚点 ----------

const anchor = (source: BalanceAnchor['source'], date: string, amountCents: number): BalanceAnchor => ({
  source,
  date,
  amountCents,
  createdAt: new Date(`${date}T12:00:00Z`),
});
const BASE_ANCHORS: Record<string, BalanceAnchor[]> = {
  [PLUS]: [anchor('pdf', '2026-10-31', 1000000), anchor('pdf', '2026-11-30', 1052500)],
  [SAVER]: [anchor('manual', '2026-11-30', 1500000)],
  [WESTPAC]: [anchor('manual', '2026-11-30', 0)],
};

type EvalOpts = {
  today?: string;
  txs?: readonly ConditionTx[];
  accounts?: ConditionAccount[];
  anchors?: Record<string, BalanceAnchor[]>;
  checks?: Record<string, ManualCheck>;
};

function evaluate(condition: MonthlyCondition, month: string, opts: EvalOpts = {}) {
  const txs = opts.txs ?? BASE_TXS;
  const accounts = opts.accounts ?? accountsFor(txs);
  return evaluateCondition(condition, {
    account: accounts.find((a) => a.id === condition.accountId)!,
    accounts,
    month,
    today: opts.today ?? TODAY,
    transactions: txs,
    anchors: (opts.anchors ?? BASE_ANCHORS)[condition.accountId] ?? [],
    manualCheck: (opts.checks ?? BASE_CHECKS)[`${condition.id} ${month}`] ?? null,
  });
}

// ---------- R24.6 数据截至 ----------

describe('dataAsOf（R24.6）', () => {
  it('R24.6: as-of per account, pending not counted', () => {
    const accounts = accountsFor(BASE_TXS);
    const asOf = Object.fromEntries(accounts.map((a) => [a.id, a.asOf]));
    expect(asOf).toEqual({
      [JOINT]: '2026-12-20', // j15 pending 不算
      [MALE]: '2026-12-15',
      [PLUS]: '2026-11-30',
      [SAVER]: '2026-12-16',
      [FEMALE]: '2026-12-22', // f9 pending 不算
      [WESTPAC]: '2026-11-30', // 只有开户锚点
    });
  });

  it('R24.6: no anchor and no confirmed transaction → null, shown as 还没有数据', () => {
    expect(dataAsOf(null, [])).toBeNull();
    expect(dataAsOf(null, [tx('x', JOINT, '2026-12-01', 100, { status: 'pending' })])).toBeNull();
    expect(asOfLabel(null)).toBe('还没有数据');
    expect(asOfLabel('2026-12-20')).toBe('数据截至 12-20');
  });
});

// ---------- R24.3 对方账户 ----------

describe('resolveCounterparty（R24.3）', () => {
  const base = { accountId: JOINT, pairAccountId: null, maskedDescription: 'SALARY' };

  it('R24.3: paired transfer → the paired transaction account (j12 → ANZ Male)', () => {
    expect(
      resolveCounterparty({ ...base, transferStatus: 'auto', pairAccountId: MALE }, BANK_ACCOUNTS),
    ).toBe(MALE);
  });

  it('R24.3: unpaired auto transfer → storedTransferAccountId (j13 ****0004 → ANZ Plus Male)', () => {
    expect(
      resolveCounterparty(
        { ...base, transferStatus: 'auto', maskedDescription: 'ANZ M-BANKING FUNDS TFER TRANSFER 100000  FROM  ****0004' },
        BANK_ACCOUNTS,
      ),
    ).toBe(PLUS);
    expect(
      resolveCounterparty(
        { ...base, transferStatus: 'confirmed', maskedDescription: 'ANZ M-BANKING FUNDS TFER TRANSFER 100000  FROM  ****0004' },
        BANK_ACCOUNTS,
      ),
    ).toBe(PLUS);
  });

  it('R24.3: auto transfer whose description no longer matches → unknown', () => {
    expect(
      resolveCounterparty(
        { ...base, transferStatus: 'auto', maskedDescription: 'ANZ M-BANKING FUNDS TFER TRANSFER 100000  FROM  ****9999' },
        BANK_ACCOUNTS,
      ),
    ).toBeNull();
  });

  it('R24.3: none and suggested → unknown even if the description has a suffix', () => {
    const desc = 'ANZ M-BANKING FUNDS TFER TRANSFER 100000  FROM  ****0004';
    expect(resolveCounterparty({ ...base, transferStatus: 'none', maskedDescription: desc }, BANK_ACCOUNTS)).toBeNull();
    expect(
      resolveCounterparty({ ...base, transferStatus: 'suggested', maskedDescription: desc }, BANK_ACCOUNTS),
    ).toBeNull();
  });
});

// ---------- R24.2、R24.3 存入 ----------

describe('countableDeposits（R24.2、R24.3）', () => {
  const accounts = accountsFor(BASE_TXS);
  const inDecember = (accountId: string) =>
    BASE_TXS.filter((t) => t.accountId === accountId && t.date >= '2026-12-01' && t.date <= '2026-12-31');

  it('R24.2: any — interest, fee reversal and pending excluded; refunds and own transfers counted (A-1)', () => {
    const joint = accounts.find((a) => a.id === JOINT)!;
    expect(countableDeposits(inDecember(JOINT), joint, 'any', accounts)).toEqual({
      totalCents: 191999,
      unknownCount: 0,
    });
  });

  it('R24.3: exclude_linked drops transfers back from the linked saver, unknown counted (B-1)', () => {
    const male = accounts.find((a) => a.id === MALE)!;
    expect(countableDeposits(inDecember(MALE), male, 'exclude_linked', accounts)).toEqual({
      totalCents: 80000,
      unknownCount: 1,
    });
  });

  it('R24.2: a split partly in Bank fees only removes that part', () => {
    const joint = accounts.find((a) => a.id === JOINT)!;
    const mixed = { ...tx('x', JOINT, '2026-12-03', 10000), bankFeeCents: 300 };
    expect(countableDeposits([mixed], joint, 'any', accounts).totalCents).toBe(9700);
  });
});

// ---------- 场景 A：min_deposit ----------

describe('R24 场景 A：min_deposit', () => {
  it('R24 A-1: ANZ Joint December in progress, 8001 short', () => {
    const r = evaluate(K2, '2026-12-01');
    expect(r).toMatchObject({ status: 'in_progress', currentValue: 191999, target: 200000, remaining: 8001 });
    expect(describeCondition(r)).toBe('存入 $1,919.99 / $2,000.00，还差 $80.01');
    expect(asOfLabel(r.asOf)).toBe('数据截至 12-20');
  });

  it('R24 A-2: exactly enough is met mid-month', () => {
    const txs = [...BASE_TXS, J16_ENOUGH];
    const r = evaluate(K2, '2026-12-01', { txs });
    expect(r).toMatchObject({ status: 'met', currentValue: 200000, remaining: 0 });
    expect(describeCondition(r)).toBe('存入 $2,000.00 / $2,000.00');
    expect(asOfLabel(r.asOf)).toBe('数据截至 12-28');
  });

  it('R24 A-3: one cent short — in progress, then failed with stale as-of after month end', () => {
    const txs = [...BASE_TXS, J16_SHORT];
    const now = evaluate(K2, '2026-12-01', { txs });
    expect(now).toMatchObject({ status: 'in_progress', remaining: 1 });
    expect(describeCondition(now)).toBe('存入 $1,999.99 / $2,000.00，还差 $0.01');

    const later = evaluate(K2, '2026-12-01', { txs, today: '2027-01-02' });
    expect(later).toMatchObject({ status: 'failed', remaining: 1 });
    expect(describeCondition(later)).toBe('存入 $1,999.99 / $2,000.00，还差 $0.01（数据截至 12-28，可能不准）');
  });

  it('R24 A-4: past months use the condition amount of that condition', () => {
    expect(evaluate(K1, '2026-09-01')).toMatchObject({ status: 'met', currentValue: 160000 });
    expect(evaluate(K2, '2026-10-01')).toMatchObject({ status: 'met', currentValue: 200000 });
    expect(evaluate(K13, '2026-11-01')).toMatchObject({ status: 'met', currentValue: 199600 });
  });

  it('R24 A-4: November fee reversal j7 is not a deposit → failed, 400 short, no stale suffix', () => {
    const r = evaluate(K2, '2026-11-01');
    expect(r).toMatchObject({ status: 'failed', currentValue: 199600, remaining: 400 });
    expect(describeCondition(r)).toBe('存入 $1,996.00 / $2,000.00，还差 $4.00');
  });

  it('R24 B-3: any does not show the unknown-counterparty note', () => {
    expect(unknownDepositNote(evaluate(K2, '2026-12-01'))).toBeNull();
  });
});

// ---------- 场景 B：exclude_linked ----------

describe('R24 场景 B：exclude_linked', () => {
  it('R24 B-1: ANZ Male December — m2 from linked saver excluded, PayID m3 counted', () => {
    const r = evaluate(K3, '2026-12-01');
    expect(r).toMatchObject({ status: 'in_progress', currentValue: 80000, remaining: 20000 });
    expect(describeCondition(r)).toBe('存入 $800.00 / $1,000.00，还差 $200.00');
    expect(asOfLabel(r.asOf)).toBe('数据截至 12-15');
    expect(unknownDepositNote(r)).toBe('1 笔存入认不出来自哪个账户，按算数处理');
  });

  it('R24 B-2: ANZ Male November — unknown salary counts, met', () => {
    const r = evaluate(K3, '2026-11-01');
    expect(r).toMatchObject({ status: 'met', currentValue: 100000 });
    expect(describeCondition(r)).toBe('存入 $1,000.00 / $1,000.00');
    expect(unknownDepositNote(r)).toBe('1 笔存入认不出来自哪个账户，按算数处理');
  });
});

// ---------- 场景 C：no_withdrawal ----------

describe('R24 场景 C：no_withdrawal', () => {
  it('R24 C-1: November met; interest is not a withdrawal', () => {
    const r = evaluate(K6, '2026-11-01');
    expect(r.status).toBe('met');
    expect(describeCondition(r)).toBe('没有取款');
  });

  it('R24 C-1: December in progress — interest reversal and fee are not withdrawals', () => {
    const r = evaluate(K6, '2026-12-01');
    expect(r.status).toBe('in_progress');
    expect(describeCondition(r)).toBe('到目前没有取款');
    expect(asOfLabel(r.asOf)).toBe('数据截至 12-16');
  });

  it('R24 C-1: December met after month end, stale as-of suffix', () => {
    const r = evaluate(K6, '2026-12-01', { today: '2027-01-02' });
    expect(r.status).toBe('met');
    expect(describeCondition(r)).toBe('没有取款（数据截至 12-16，可能不准）');
  });

  it('R24 C-2: transfer to everyday is a withdrawal, failed mid-month', () => {
    const txs = [...BASE_TXS, ...V_S1];
    const now = evaluate(K6, '2026-12-01', { txs });
    expect(now).toMatchObject({
      status: 'failed',
      withdrawal: { date: '2026-12-03', amountCents: 20000, counterpartyName: 'CBA Female', count: 1 },
    });
    expect(describeCondition(now)).toBe('12-03 转出 $200.00 到 CBA Female');

    const later = evaluate(K6, '2026-12-01', { txs, today: '2027-01-02' });
    expect(describeCondition(later)).toBe('12-03 转出 $200.00 到 CBA Female（数据截至 12-16，可能不准）');
  });

  it('R24 C-3: unknown counterparty shows merchant', () => {
    const r = evaluate(K6, '2026-12-01', { txs: [...BASE_TXS, ...V_S2] });
    expect(r.status).toBe('failed');
    expect(describeCondition(r)).toBe('12-20 取出 $30.00（CBA ATM）');
  });

  it('R24 C-3: several withdrawals — earliest one plus the count', () => {
    const r = evaluate(K6, '2026-12-01', { txs: [...BASE_TXS, ...V_S2, ...V_S1] });
    expect(describeCondition(r)).toBe('12-03 转出 $200.00 到 CBA Female，本月共 2 笔取款');
  });

  it('R24.5: same-day withdrawals pick the earliest created_at', () => {
    const first = tx('w1', SAVER, '2026-12-04', -1000, { merchant: 'FIRST' });
    const second = tx('w2', SAVER, '2026-12-04', -2000, { merchant: 'SECOND' });
    // 数组里 second 在前，first 的 created_at 更早
    const r = evaluate(K6, '2026-12-01', { txs: [...BASE_TXS, second, first] });
    expect(describeCondition(r)).toBe('12-04 取出 $10.00（FIRST），本月共 2 笔取款');
  });
});

// ---------- 场景 E：关联账户 ----------

describe('R24 场景 E：关联账户', () => {
  it('R24 E-1: linked_min_deposit November met, looks at ANZ Male', () => {
    const r = evaluate(K5, '2026-11-01');
    expect(r).toMatchObject({ status: 'met', currentValue: 100000 });
    expect(describeCondition(r)).toBe('ANZ Male：存入 $1,000.00 / $1,000.00');
    expect(unknownDepositNote(r)).toBe('1 笔存入认不出来自哪个账户，按算数处理');
  });

  it('R24 E-1: linked_min_deposit December — m2 from this saver excluded, as-of of ANZ Male', () => {
    const r = evaluate(K5, '2026-12-01');
    expect(r).toMatchObject({ status: 'in_progress', currentValue: 80000, remaining: 20000 });
    expect(describeCondition(r)).toBe('ANZ Male：存入 $800.00 / $1,000.00，还差 $200.00');
    expect(asOfLabel(r.asOf)).toBe('数据截至 12-15');
  });

  it('R24 E-2: card count skips transfers, suggestions, fees, refunds and pending', () => {
    const r = evaluate(K8, '2026-12-01');
    expect(r).toMatchObject({ status: 'in_progress', currentValue: 4, target: 5, remaining: 1 });
    expect(describeCondition(r)).toBe('CBA Female：刷卡 4 / 5 笔，还差 1 笔');
    expect(asOfLabel(r.asOf)).toBe('数据截至 12-22');
  });

  it('R24 E-2 V-F1: f9 confirmed → 5 cards, met', () => {
    const r = evaluate(K8, '2026-12-01', { txs: V_F1 });
    expect(r).toMatchObject({ status: 'met', currentValue: 5 });
    expect(describeCondition(r)).toBe('CBA Female：刷卡 5 / 5 笔');
    expect(asOfLabel(r.asOf)).toBe('数据截至 12-22');
  });

  it('R24 E-2: V-S1 incoming f11 does not change the card count', () => {
    expect(evaluate(K8, '2026-12-01', { txs: [...BASE_TXS, ...V_S1] }).currentValue).toBe(4);
  });

  it('R24 E-3: no linked account → unknown', () => {
    const r = evaluate(K10, '2026-12-01');
    expect(r).toMatchObject({ status: 'unknown', unknownReason: 'no_linked_account' });
    expect(describeCondition(r)).toBe('关联账户没设置');
  });

  it('R24 E-4 V-P1: link removed → K5 unknown in every month, K3 counts m2', () => {
    const accounts = accountsFor(BASE_TXS, { [PLUS]: { linkedAccountId: null } });
    for (const month of ['2026-11-01', '2026-12-01']) {
      const r = evaluate(K5, month, { accounts });
      expect(r.status).toBe('unknown');
      expect(describeCondition(r)).toBe('关联账户没设置');
    }
    expect(evaluate(K3, '2026-12-01', { accounts })).toMatchObject({ status: 'met', currentValue: 200000 });
  });

  it('R24.1: archived linked account is still evaluated, label marks it', () => {
    const accounts = accountsFor(BASE_TXS).map((a) => (a.id === FEMALE ? { ...a, archived: true } : a));
    const r = evaluate(K8, '2026-12-01', { accounts });
    expect(r.status).toBe('in_progress');
    expect(describeCondition(r)).toBe('CBA Female（已归档）：刷卡 4 / 5 笔，还差 1 笔');
  });
});

// ---------- 场景 F：F-2 里 M10-2 管的两个 ----------

describe('R24 场景 F-2（V-S1 + V-F1，今天 2027-01-02）', () => {
  const txs = [...V_F1, ...V_S1];
  const today = '2027-01-02';

  it('R24 F-2: K6 failed with stale suffix', () => {
    const r = evaluate(K6, '2026-12-01', { txs, today });
    expect(r.status).toBe('failed');
    expect(describeCondition(r)).toBe('12-03 转出 $200.00 到 CBA Female（数据截至 12-16，可能不准）');
  });

  it('R24 F-2: K8 met with stale suffix from CBA Female as-of', () => {
    const r = evaluate(K8, '2026-12-01', { txs, today });
    expect(r.status).toBe('met');
    expect(describeCondition(r)).toBe('CBA Female：刷卡 5 / 5 笔（数据截至 12-22，可能不准）');
  });
});

// ---------- 场景 D：balance_growth ----------

describe('R24 场景 D：balance_growth', () => {
  it('R24 D-1: ANZ Plus Male November — month-end anchor above last month, met', () => {
    const r = evaluate(K4, '2026-11-01');
    expect(r).toMatchObject({ status: 'met', currentValue: 1052500, target: 1000000 });
    expect(describeCondition(r)).toBe('月末 $10,525.00，比上月末多 $525.00');
  });

  it('R24 D-2: ANZ Plus Male December — same as last month, in progress then failed', () => {
    const now = evaluate(K4, '2026-12-01');
    expect(now).toMatchObject({ status: 'in_progress', currentValue: 1052500, target: 1052500 });
    expect(describeCondition(now)).toBe('现在 $10,525.00，和上月末一样');
    expect(asOfLabel(now.asOf)).toBe('数据截至 11-30');

    const later = evaluate(K4, '2026-12-01', { today: '2027-01-02' });
    expect(later.status).toBe('failed');
    expect(describeCondition(later)).toBe('月末 $10,525.00，和上月末一样（数据截至 11-30，可能不准）');
  });

  it('R24 D-3: December statement imported — month-end lower, failed without stale suffix', () => {
    const txs = [
      ...BASE_TXS,
      tx('p3', PLUS, '2026-12-02', -120000, auto(MALE)),
      tx('p4', PLUS, '2026-12-16', -10000, auto(JOINT)),
      tx('p5', PLUS, '2026-12-31', 2600, interest),
    ];
    const anchors = { ...BASE_ANCHORS, [PLUS]: [...BASE_ANCHORS[PLUS]!, anchor('pdf', '2026-12-31', 925100)] };
    const accounts = accountsFor(txs, { [PLUS]: { anchorDate: '2026-12-31' } });
    const opts = { txs, anchors, accounts, today: '2027-01-05' };

    const r = evaluate(K4, '2026-12-01', opts);
    expect(r).toMatchObject({ status: 'failed', currentValue: 925100, asOf: '2026-12-31', stale: false });
    expect(describeCondition(r)).toBe('月末 $9,251.00，比上月末少 $1,274.00');

    // K3、K5 存入不变：m2 照样不算
    expect(evaluate(K3, '2026-12-01', opts).currentValue).toBe(80000);
    expect(evaluate(K5, '2026-12-01', opts).currentValue).toBe(80000);
  });

  it('R24 D-4: CBA Female Saver November — no anchor at last month end → unknown, not failed', () => {
    const r = evaluate(K7, '2026-11-01');
    expect(r).toMatchObject({ status: 'unknown', unknownReason: 'no_balance' });
    expect(describeCondition(r)).toBe('没有余额，判断不了');
  });

  it('R24 D-5: CBA Female Saver December — anchor-day interest not added again', () => {
    const now = evaluate(K7, '2026-12-01');
    expect(now).toMatchObject({ status: 'in_progress', currentValue: 1549500, target: 1500000 });
    expect(describeCondition(now)).toBe('现在 $15,495.00，比上月末多 $495.00');

    const later = evaluate(K7, '2026-12-01', { today: '2027-01-02' });
    expect(later.status).toBe('met');
    expect(describeCondition(later)).toBe('月末 $15,495.00，比上月末多 $495.00（数据截至 12-16，可能不准）');
  });

  it('R24.4: balance below last month mid-month shows 少', () => {
    const r = evaluate(K7, '2026-12-01', { txs: [...BASE_TXS, tx('x', SAVER, '2026-12-20', -100000)] });
    expect(r.status).toBe('in_progress');
    expect(describeCondition(r)).toBe('现在 $14,495.00，比上月末少 $505.00');
  });
});

// ---------- 场景 G：other ----------

describe('R24 场景 G：other', () => {
  it('R24 G-1: November checked → met; December not checked → unknown', () => {
    const nov = evaluate(K9, '2026-11-01');
    expect(nov.status).toBe('met');
    expect(describeCondition(nov)).toBe('满足了');

    const dec = evaluate(K9, '2026-12-01');
    expect(dec).toMatchObject({ status: 'unknown', unknownReason: 'not_checked' });
    expect(describeCondition(dec)).toBe('还没勾');
  });

  it('R24 G-2, G-3, G-4: met, then failed, then cleared', () => {
    const at = (check: ManualCheck | undefined) =>
      evaluate(K9, '2026-12-01', { checks: check ? { 'K9 2026-12-01': check } : {} });
    expect(at('met').status).toBe('met');
    expect(at('failed').status).toBe('failed');
    expect(describeCondition(at('failed'))).toBe('没满足');
    expect(at(undefined).status).toBe('unknown');
  });

  it('R24 G-7: month over, still not checked → unknown, no stale suffix', () => {
    const r = evaluate(K9, '2026-12-01', { today: '2027-01-02' });
    expect(r.status).toBe('unknown');
    expect(describeCondition(r)).toBe('还没勾');
  });
});

// ---------- 场景 F：合并 ----------

const judgedIn = (accountId: string, month: string) =>
  ALL_CONDITIONS.filter((c) => c.accountId === accountId && isJudgedIn(PERIODS[c.id]!, month));

function accountMonth(accountId: string, month: string, opts: EvalOpts = {}) {
  const conditions = judgedIn(accountId, month);
  const results = conditions.map((c) => evaluate(c, month, opts));
  return { results, summary: summarizeAccountMonth(conditions, results) };
}

describe('R24 场景 F：summarizeAccountMonth', () => {
  it('R24 F-1: base data, today 2026-12-28', () => {
    expect(accountMonth(PLUS, '2026-11-01').summary.byOutcome).toEqual({ bonus: 'met' });
    expect(accountMonth(PLUS, '2026-12-01').summary.byOutcome).toEqual({ bonus: 'in_progress' });
    expect(accountMonth(SAVER, '2026-11-01').summary.byOutcome).toEqual({ bonus: 'unknown' });
    expect(accountMonth(SAVER, '2026-12-01').summary.byOutcome).toEqual({ bonus: 'in_progress' });
    expect(accountMonth(JOINT, '2026-11-01').summary.byOutcome).toEqual({ fee_waiver: 'failed', bonus: 'met' });
  });

  it('R24 F-2: one failed, others met → bonus missed (V-S1 + V-F1, today 2027-01-02)', () => {
    const txs = [...V_F1, ...V_S1];
    const { results, summary } = accountMonth(SAVER, '2026-12-01', { txs, today: '2027-01-02' });
    expect(results.map((r) => r.status)).toEqual(['failed', 'met', 'met']); // K6、K7、K8
    expect(describeCondition(results[1]!)).toBe('月末 $15,295.00，比上月末多 $295.00（数据截至 12-16，可能不准）');
    expect(summary.byOutcome).toEqual({ bonus: 'failed' });
    expect(outcomeSummaryText('bonus', 'failed')).toBe('bonus：没拿到');
  });

  it('R24 F-2: only V-S1 mid-month — failed beats in_progress', () => {
    const { summary } = accountMonth(SAVER, '2026-12-01', { txs: [...BASE_TXS, ...V_S1] });
    expect(summary.byOutcome).toEqual({ bonus: 'failed' });
  });

  it('R24 E-4 V-P1: ANZ Plus Male November cell is unknown (K4 met + K5 unknown)', () => {
    const accounts = accountsFor(BASE_TXS, { [PLUS]: { linkedAccountId: null } });
    expect(accountMonth(PLUS, '2026-11-01', { accounts }).summary.overall).toBe('unknown');
  });

  it('R24.5: no judged condition → no summary', () => {
    expect(summarizeAccountMonth([], [])).toEqual({ byOutcome: {}, overall: null });
  });
});

// ---------- 场景 H：月费校验 ----------

const txsOf = (accountId: string, txs: readonly ConditionTx[] = BASE_TXS) =>
  txs.filter((t) => t.accountId === accountId);

function mismatch(accountId: string, month: string, opts: EvalOpts = {}) {
  return feeMismatch(accountMonth(accountId, month, opts).summary, txsOf(accountId, opts.txs), month);
}

describe('R24 场景 H：feeMismatch', () => {
  it('R24 H-1: ANZ Male November met but charged $5 (m1 on 12-01 belongs to December)', () => {
    expect(mismatch(MALE, '2026-11-01')).toBe(500);
    expect(feeMismatchText(500)).toBe('这个月判断满足了，但还是收了 $5.00 月费，条件配置可能不对');
  });

  it('R24 H-2: ANZ Joint October — fee charged and reversed, net 0 → none', () => {
    expect(mismatch(JOINT, '2026-10-01')).toBeNull();
  });

  it('R24 H-3: CBA Female December, other checked met → $6 this month too', () => {
    const checks = { ...BASE_CHECKS, 'K9 2026-12-01': 'met' as const };
    expect(mismatch(FEMALE, '2026-12-01', { checks })).toBe(600);
  });

  it('R24 H-4, H-5, H-6: in progress, missed, or met with no net fee → none', () => {
    expect(mismatch(MALE, '2026-12-01')).toBeNull();
    expect(mismatch(JOINT, '2026-11-01')).toBeNull();
    expect(mismatch(JOINT, '2026-09-01')).toBeNull();
  });

  it('R24 H-7: bonus only conditions are not checked', () => {
    const txs = [...V_F1];
    const opts = { txs, today: '2027-01-02' };
    const { summary } = accountMonth(SAVER, '2026-12-01', opts);
    expect(summary.byOutcome).toEqual({ bonus: 'met' });
    expect(feeMismatch(summary, txsOf(SAVER, txs), '2026-12-01')).toBeNull();
  });

  it('R24.8: pending fees do not count', () => {
    const txs = [...BASE_TXS, tx('x', JOINT, '2026-10-31', -700, { ...fee, status: 'pending' })];
    expect(mismatch(JOINT, '2026-10-01', { txs })).toBeNull();
  });
});

// ---------- 场景 I：首页提示 ----------

const ACCOUNT_NAMES = Object.fromEntries(BASE_ACCOUNTS.map((a) => [a.id, a.name]));

function reminderItems(today: string, opts: EvalOpts = {}, conditions = ALL_CONDITIONS) {
  const month = `${today.slice(0, 7)}-01`;
  return conditions
    .filter((c) => isJudgedIn(PERIODS[c.id]!, month))
    .map((c) => ({ accountName: ACCOUNT_NAMES[c.accountId]!, result: evaluate(c, month, { ...opts, today }) }));
}

describe('R24 场景 I：homeReminder', () => {
  it('R24 I-1: five conditions, earliest as-of', () => {
    expect(homeReminder(reminderItems(TODAY), TODAY)).toEqual({
      count: 5,
      asOf: '2026-11-30',
      text: '5 个账户条件本月还没满足（数据截至 11-30）',
    });
  });

  it('R24 I-2: only in the last CONDITION_REMINDER_DAYS days of the month', () => {
    expect(CONDITION_REMINDER_DAYS).toBe(5);
    expect(homeReminder(reminderItems('2026-12-26'), '2026-12-26')).toBeNull();
    expect(homeReminder(reminderItems('2026-12-27'), '2026-12-27')?.count).toBe(5);
    expect(homeReminder(reminderItems('2026-12-31'), '2026-12-31')?.count).toBe(5);
    expect(homeReminder(reminderItems('2027-01-01'), '2027-01-01')).toBeNull();
  });

  it('R24 I-2: inReminderWindow is the last CONDITION_REMINDER_DAYS days', () => {
    expect(inReminderWindow('2026-12-26')).toBe(false);
    expect(inReminderWindow('2026-12-27')).toBe(true);
    expect(inReminderWindow('2026-12-31')).toBe(true);
    expect(inReminderWindow('2027-01-01')).toBe(false);
  });

  it('R24 I-2: last month results are not reminded', () => {
    const december = ALL_CONDITIONS.filter((c) => isJudgedIn(PERIODS[c.id]!, '2026-12-01')).map((c) => ({
      accountName: ACCOUNT_NAMES[c.accountId]!,
      result: evaluate(c, '2026-12-01', { today: '2027-01-28' }),
    }));
    // 1 月最后 5 天里，传进来的是 12 月的结果
    expect(homeReminder(december, '2027-01-28')).toBeNull();
  });

  it('R24 I-3: a single condition gets its own line', () => {
    const only = (c: MonthlyCondition) => homeReminder(reminderItems(TODAY, {}, [c]), TODAY)?.text ?? null;
    expect(only(K2)).toBe('ANZ Joint 本月存入还差 $80.01（数据截至 12-20）');
    expect(only(K5)).toBe('ANZ Plus Male 的关联账户 ANZ Male 本月存入还差 $200.00（数据截至 12-15）');
    expect(only(K8)).toBe('CBA Female Saver 的关联账户 CBA Female 本月刷卡还差 1 笔（数据截至 12-22）');
    expect(only(K4)).toBe('ANZ Plus Male 现在和上月末一样，月底要比上月末高（数据截至 11-30）');
    expect(only(K6)).toBeNull();
    expect(only(K7)).toBeNull();
  });

  it('R24.9: balance_growth below last month says 少', () => {
    const txs = [...BASE_TXS, tx('x', SAVER, '2026-12-20', -100000)];
    expect(homeReminder(reminderItems(TODAY, { txs }, [K7]), TODAY)?.text).toBe(
      'CBA Female Saver 现在比上月末少 $505.00（数据截至 12-20）',
    );
  });

  it('R24.9: no as-of date → 还没有数据', () => {
    const accounts = accountsFor(BASE_TXS).map((a) => (a.id === JOINT ? { ...a, asOf: null } : a));
    expect(homeReminder(reminderItems(TODAY, { accounts }, [K2]), TODAY)?.text).toBe(
      'ANZ Joint 本月存入还差 $80.01（还没有数据）',
    );
  });

  it('R24 I-4: variants', () => {
    expect(homeReminder(reminderItems(TODAY, { txs: [...BASE_TXS, J16_ENOUGH] }), TODAY)?.text).toBe(
      '4 个账户条件本月还没满足（数据截至 11-30）',
    );
    expect(homeReminder(reminderItems(TODAY, { txs: [...BASE_TXS, ...V_S1] }), TODAY)?.count).toBe(5);
    const accounts = accountsFor(BASE_TXS, { [PLUS]: { linkedAccountId: null } });
    expect(homeReminder(reminderItems(TODAY, { accounts }), TODAY)?.text).toBe(
      '3 个账户条件本月还没满足（数据截至 11-30）',
    );
  });
});

// ---------- 场景 J、K：历史和生效月份 ----------

const periodsOf = (accountId: string) =>
  ALL_CONDITIONS.filter((c) => c.accountId === accountId).map((c) => PERIODS[c.id]!);

describe('R24 场景 J：monthsForHistory 和小格', () => {
  const cells = (accountId: string) =>
    Object.fromEntries(
      monthsForHistory(periodsOf(accountId), TODAY).map((month) => {
        const { summary } = accountMonth(accountId, month);
        return [month.slice(0, 7), summary.overall === null ? '没有条件' : MONTH_CELL_LABELS[summary.overall]];
      }),
    );

  it('R24 J: cells per account from the earliest effective_from', () => {
    expect(cells(JOINT)).toEqual({ '2026-09': '满足', '2026-10': '满足', '2026-11': '失败', '2026-12': '进行中' });
    expect(cells(MALE)).toEqual({ '2026-11': '满足', '2026-12': '进行中' });
    expect(cells(PLUS)).toEqual({ '2026-11': '满足', '2026-12': '进行中' });
    expect(cells(SAVER)).toEqual({ '2026-11': '判断不了', '2026-12': '进行中' });
    expect(cells(FEMALE)).toEqual({ '2026-11': '满足', '2026-12': '判断不了' });
    expect(cells(WESTPAC)).toEqual({ '2026-12': '判断不了' });
  });

  it('R24 J: only ANZ Male November is flagged for fees', () => {
    const flagged = [JOINT, MALE, PLUS, SAVER, FEMALE, WESTPAC].flatMap((id) =>
      monthsForHistory(periodsOf(id), TODAY)
        .filter((month) => mismatch(id, month) !== null)
        .map((month) => `${id} ${month}`),
    );
    expect(flagged).toEqual([`${MALE} 2026-11-01`]);
  });

  it('R24 J: ANZ Joint November detail', () => {
    const { results, summary } = accountMonth(JOINT, '2026-11-01');
    expect(results.map((r) => [r.conditionId, r.status, describeCondition(r)])).toEqual([
      ['K2', 'failed', '存入 $1,996.00 / $2,000.00，还差 $4.00'],
      ['K13', 'met', '存入 $1,996.00 / $500.00'],
    ]);
    expect(outcomeSummaryText('fee_waiver', summary.byOutcome.fee_waiver!)).toBe('免月费：没拿到');
    expect(outcomeSummaryText('bonus', summary.byOutcome.bonus!)).toBe('bonus：拿到');
  });

  it('R24 J: this month ANZ Joint only judges K2', () => {
    expect(judgedIn(JOINT, '2026-12-01').map((c) => c.id)).toEqual(['K2']);
    expect(judgedIn(SAVER, '2026-12-01').map((c) => c.id)).toEqual(['K6', 'K7', 'K8']);
  });

  it('R24.10: at most the last 12 months including this month', () => {
    const months = monthsForHistory([{ effectiveFrom: '2025-06-01', disabledFrom: null }], TODAY);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2026-01-01');
    expect(months[11]).toBe('2026-12-01');
  });
});

describe('R24 场景 K：生效月份', () => {
  it('R24.1: judged months are effective_from ≤ month < disabled_from', () => {
    expect(isJudgedIn(PERIODS.K1!, '2026-09-15')).toBe(true);
    expect(isJudgedIn(PERIODS.K1!, '2026-10-01')).toBe(false);
    expect(isJudgedIn(PERIODS.K2!, '2026-09-30')).toBe(false);
    expect(isJudgedIn(PERIODS.K2!, '2027-06-01')).toBe(true);
  });

  it('R24 K-10: edited amount — December uses the new condition', () => {
    const K2b = cond({ ...K2, id: "K2'", amountCents: 250000 });
    expect(describeCondition(evaluate(K2b, '2026-12-01'))).toBe('存入 $1,919.99 / $2,500.00，还差 $580.01');
  });

  it('R24 K-11: deleted K3 — history keeps November, December has no condition', () => {
    const periods = [{ effectiveFrom: '2026-11-01', disabledFrom: '2026-12-01' }];
    expect(monthsForHistory(periods, TODAY)).toEqual(['2026-11-01', '2026-12-01']);
    expect(isJudgedIn(periods[0]!, '2026-12-01')).toBe(false);
  });

  it('R24 K-12: no_withdrawal from October with no transactions → met', () => {
    const c = cond({ id: 'new', accountId: MALE, outcome: 'bonus', type: 'no_withdrawal' });
    expect(monthsForHistory([{ effectiveFrom: '2026-10-01', disabledFrom: null }], TODAY)).toEqual([
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
    ]);
    expect(evaluate(c, '2026-10-01').status).toBe('met');
  });

  it('R24 K-13: added and removed in the same month → never judged, no history', () => {
    const periods = [{ effectiveFrom: '2026-12-01', disabledFrom: '2026-12-01' }];
    expect(isJudgedIn(periods[0]!, '2026-12-01')).toBe(false);
    expect(monthsForHistory(periods, TODAY)).toEqual([]);
  });
});
