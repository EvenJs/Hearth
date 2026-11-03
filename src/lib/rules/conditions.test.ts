import { describe, expect, it } from 'vitest';
import {
  asOfLabel,
  countableDeposits,
  dataAsOf,
  describeCondition,
  evaluateCondition,
  resolveCounterparty,
  unknownDepositNote,
  type ConditionAccount,
  type ConditionTx,
  type MonthlyCondition,
} from './conditions';
import type { Account } from './types';

// 期望值来自 docs/rules/R24-monthly-condition.md 和 fixtures/cases/15-monthly-conditions.md
// 今天默认 2026-12-28。M10-2 只测 min_deposit、no_withdrawal、linked_min_deposit、linked_card_count

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
  feeOrInterest?: boolean; // 整笔拆分是 Bank fees 或 Income / Interest
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
  feeInterestCents: opts.feeOrInterest ? amountCents : 0,
  merchant: opts.merchant ?? null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)),
});
const fee = { feeOrInterest: true };
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
  tx('j9', JOINT, '2026-12-05', 2312, fee),
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
  tx('p2', PLUS, '2026-11-30', 2500, fee),
  // CBA Female Saver
  tx('s1', SAVER, '2026-11-30', 900, fee),
  tx('s2', SAVER, '2026-12-06', 50000, auto(FEMALE)),
  tx('s3', SAVER, '2026-12-10', 120, fee),
  tx('s4', SAVER, '2026-12-15', -120, fee),
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

function evaluate(
  condition: MonthlyCondition,
  month: string,
  opts: { today?: string; txs?: readonly ConditionTx[]; accounts?: ConditionAccount[] } = {},
) {
  const txs = opts.txs ?? BASE_TXS;
  const accounts = opts.accounts ?? accountsFor(txs);
  return evaluateCondition(condition, {
    account: accounts.find((a) => a.id === condition.accountId)!,
    accounts,
    month,
    today: opts.today ?? TODAY,
    transactions: txs,
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
    const mixed = { ...tx('x', JOINT, '2026-12-03', 10000), feeInterestCents: 300 };
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
