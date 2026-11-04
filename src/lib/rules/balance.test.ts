import { describe, expect, it } from 'vitest';
import {
  anchorFromBatch,
  balanceAt,
  calibrationDiff,
  currentBalance,
  groupByPurpose,
  lastCalibrationDiff,
  openingAnchorDate,
  pickAnchor,
  previousAnchor,
  validateLink,
  type BalanceAnchor,
  type BalanceTx,
} from './balance';

// 期望值来自 docs/rules/R23-balance.md 和 fixtures/cases/14-balance.md（今天 = 2026-12-10）

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
const pdf = (date: string, amountCents: number, created: string): BalanceAnchor => ({
  source: 'pdf',
  date,
  amountCents,
  createdAt: at(created),
});
const manual = (date: string, amountCents: number, created: string): BalanceAnchor => ({
  source: 'manual',
  date,
  amountCents,
  createdAt: at(created),
});
const c = (date: string, amountCents: number): BalanceTx => ({ date, amountCents, status: 'confirmed' });
const p = (date: string, amountCents: number): BalanceTx => ({ date, amountCents, status: 'pending' });

// ---------- 场景 A：ANZ Joint ----------

const A_PDF0 = anchorFromBatch({
  source: 'pdf',
  dateTo: '2026-10-04',
  closingBalanceCents: 480000,
  createdAt: at('2026-10-06'),
});
const A_PDF1 = anchorFromBatch({
  source: 'pdf',
  dateTo: '2026-11-04',
  closingBalanceCents: 523450,
  createdAt: at('2026-11-06'),
});
const A_C1 = anchorFromBatch({
  source: 'csv',
  dateTo: '2026-12-07',
  closingBalanceCents: 999999,
  createdAt: at('2026-12-08'),
});
const A_BATCH_ANCHORS = [A_PDF0, A_PDF1, A_C1].filter((a) => a !== null);

const A_TXS_BEFORE = [
  c('2026-10-10', -15000), // a1
  c('2026-10-18', 30000), // a2
  c('2026-10-25', 34150), // a3
  p('2026-11-02', -700), // a4 旧 pending，早于锚点
  c('2026-11-03', -4500), // a5
  c('2026-11-04', -1200), // a6 锚点当天
  c('2026-11-05', -6550), // a7
  c('2026-11-20', 250000), // a8
  c('2026-12-01', -200000), // a9
  c('2026-12-07', -3210), // a10
];
const A_TXS = [
  ...A_TXS_BEFORE,
  p('2026-12-08', -4599), // a11
  p('2026-12-09', -1250), // a12
];

// ---------- 场景 B：ANZ Plus Male ----------

const B_PDF1 = pdf('2026-10-31', 1072500, '2026-11-03');
const B_PDF2 = pdf('2026-11-30', 1079700, '2026-12-03');
const B_TXS = [
  c('2026-10-31', 2400), // i5
  c('2026-11-02', 5000), // b1
  c('2026-11-12', -300), // b2
  c('2026-11-30', 2500), // b3 锚点当天
];

// ---------- 场景 D：CBA Female ----------

const D_PDF = pdf('2026-12-01', 812345, '2026-12-03');
const D_MANUAL = manual('2026-12-01', 812000, '2026-12-05');
const D_CSV = anchorFromBatch({
  source: 'csv',
  dateTo: '2026-12-08',
  closingBalanceCents: 850100,
  createdAt: at('2026-12-09'),
});
const D_TXS = [c('2026-12-01', -2000), c('2026-12-04', -12345), c('2026-12-08', 50000)];

// ---------- 场景 E：ANZ Male ----------

const E_M1 = manual('2026-11-30', 345600, '2026-12-01');
const E_M2 = manual('2026-12-06', 445250, '2026-12-09');
const E_M3 = manual('2026-12-09', 437000, '2026-12-10');
const E_TXS = [
  c('2026-11-30', -1500), // e1 M1 当天
  c('2026-12-02', -2350), // e2
  c('2026-12-04', 120000), // e3
  p('2026-12-05', -999), // e4
  c('2026-12-06', -18000), // e5
  c('2026-12-08', -5250), // e6
  p('2026-12-10', -1800), // e7
];
const E_TXS_WITH_E8 = [...E_TXS, c('2026-12-07', -3000)];

// ---------- 场景 F：新建账户 ----------

const F1_ANCHOR = manual(openingAnchorDate(new Date('2026-11-30T14:30:00Z')), 0, '2026-11-30');
const F1_TXS = [c('2026-12-01', 200000)];
const F2_ANCHOR = manual('2026-11-30', 8550, '2026-12-01');
const F2_TXS = [c('2026-12-01', -1200), c('2026-12-05', -650)];
const F3_ANCHOR = manual('2026-11-14', -45000, '2026-11-15');
const F3_TXS = [c('2026-11-15', -3000), c('2026-11-28', -12000), c('2026-12-02', 45000)];

// ---------- 场景 H：CBA Female Saver ----------

const H_ANCHOR = manual('2026-11-30', 1500000, '2026-12-01');
const H_TXS = [c('2026-11-30', 900), p('2026-12-10', 120)];

describe('anchorFromBatch（R23.1）', () => {
  it('R23.1: PDF batch → anchor at date_to with closing balance', () => {
    expect(A_PDF1).toEqual({
      source: 'pdf',
      date: '2026-11-04',
      amountCents: 523450,
      createdAt: at('2026-11-06'),
    });
  });

  it('R23.1: CSV batch is never an anchor, even with a closing balance (A C1, D CSV-C)', () => {
    expect(A_C1).toBeNull();
    expect(D_CSV).toBeNull();
  });

  it('R23.1: PDF batch without closing balance → no anchor', () => {
    expect(
      anchorFromBatch({ source: 'pdf', dateTo: '2026-11-04', closingBalanceCents: null, createdAt: at('2026-11-06') }),
    ).toBeNull();
  });
});

describe('openingAnchorDate（R23.1）', () => {
  it('R23.1: anchor date is the day before the Melbourne creation date (F-1, not UTC)', () => {
    // 2026-11-30T14:30Z = Melbourne 2026-12-01 01:30（AEDT）
    expect(openingAnchorDate(new Date('2026-11-30T14:30:00Z'))).toBe('2026-11-30');
  });
});

describe('pickAnchor（R23.1）', () => {
  it('R23.1: no anchors → null (G)', () => {
    expect(pickAnchor([])).toBeNull();
  });

  it('R23.1: latest PDF wins; CSV C1 with a later date_to is not a candidate (A-1)', () => {
    expect(pickAnchor(A_BATCH_ANCHORS)).toBe(A_PDF1);
  });

  it('R23.1: same day PDF beats manual even if manual was created later (D-1)', () => {
    expect(pickAnchor([D_MANUAL, D_PDF])).toBe(D_PDF);
  });

  it('R23.1: same day and same source → latest created_at', () => {
    const early = manual('2026-12-01', 100, '2026-12-02');
    const late = manual('2026-12-01', 200, '2026-12-04');
    expect(pickAnchor([late, early])).toBe(late);
    expect(pickAnchor([early, late])).toBe(late);
  });

  it('R23.1: manual filled earlier than the latest PDF does not replace it (A-4)', () => {
    const m = manual('2026-10-20', 500000, '2026-12-10');
    expect(pickAnchor([...A_BATCH_ANCHORS, m])).toBe(A_PDF1);
  });

  it('R23.1: undoing PDF2 falls back to PDF1 (B-2)', () => {
    expect(pickAnchor([B_PDF1, B_PDF2])).toBe(B_PDF2);
    expect(pickAnchor([B_PDF1])).toBe(B_PDF1);
  });

  it('R23.1: deleting M3 falls back to M2 (E-5)', () => {
    expect(pickAnchor([E_M1, E_M2, E_M3])).toBe(E_M3);
    expect(pickAnchor([E_M1, E_M2])).toBe(E_M2);
  });
});

describe('currentBalance（R23.2）', () => {
  it('R23.2: no anchor → no balance, even with transactions (G-1, G-3)', () => {
    expect(currentBalance(null, [c('2026-11-10', -2000)])).toBeNull();
    expect(currentBalance(null, [])).toBeNull();
  });

  it('R23.2: PDF then CSV with pendings: posted 563690, available 557841 (A-1)', () => {
    expect(currentBalance(A_PDF1, A_TXS)).toEqual({
      postedCents: 563690,
      availableCents: 557841,
      pendingCount: 2,
      pendingCents: -5849,
      asOf: '2026-12-09',
    });
  });

  it('R23.2: pending confirmed by import keeps available, posted catches up (A-2)', () => {
    const txs = [...A_TXS_BEFORE, c('2026-12-10', -4599), p('2026-12-09', -1250)];
    expect(currentBalance(A_PDF1, txs)).toEqual({
      postedCents: 559091,
      availableCents: 557841,
      pendingCount: 1,
      pendingCents: -1250,
      asOf: '2026-12-10',
    });
  });

  it('R23.2: undoing C2 turns a11 back to pending on 12-10 (A-3)', () => {
    const txs = [...A_TXS_BEFORE, p('2026-12-10', -4599), p('2026-12-09', -1250)];
    expect(currentBalance(A_PDF1, txs)).toEqual({
      postedCents: 563690,
      availableCents: 557841,
      pendingCount: 2,
      pendingCents: -5849,
      asOf: '2026-12-10',
    });
  });

  it('R23.2: only PDF, anchor-day transaction not counted (B-1)', () => {
    expect(currentBalance(B_PDF2, B_TXS)).toEqual({
      postedCents: 1079700,
      availableCents: 1079700,
      pendingCount: 0,
      pendingCents: 0,
      asOf: '2026-11-30',
    });
  });

  it('R23.2: after undoing PDF2 → PDF1 balance (B-2)', () => {
    expect(currentBalance(B_PDF1, [c('2026-10-31', 2400)])).toEqual({
      postedCents: 1072500,
      availableCents: 1072500,
      pendingCount: 0,
      pendingCents: 0,
      asOf: '2026-10-31',
    });
  });

  it('R23.2: CBA PDF anchor plus later CSV transactions = 850000 (D-1)', () => {
    const anchor = pickAnchor([D_PDF, D_MANUAL]);
    expect(currentBalance(anchor, D_TXS)).toMatchObject({
      postedCents: 850000,
      availableCents: 850000,
      asOf: '2026-12-08',
    });
  });

  it('R23.2: manual anchor M3, pending on or before anchor date not counted (E-3)', () => {
    expect(currentBalance(E_M3, E_TXS)).toEqual({
      postedCents: 437000,
      availableCents: 435200,
      pendingCount: 1,
      pendingCents: -1800,
      asOf: '2026-12-10',
    });
  });

  it('R23.2: e8 before the anchor does not change the balance (E-4)', () => {
    expect(currentBalance(E_M3, E_TXS_WITH_E8)).toMatchObject({
      postedCents: 437000,
      availableCents: 435200,
    });
  });

  it('R23.2: after deleting M3, M2 + e8 + e6 + e7 (E-5)', () => {
    expect(currentBalance(pickAnchor([E_M1, E_M2]), E_TXS_WITH_E8)).toEqual({
      postedCents: 437000,
      availableCents: 435200,
      pendingCount: 1,
      pendingCents: -1800,
      asOf: '2026-12-10',
    });
  });

  it('R23.2: opening balance $0, transaction on the creation day counts (F-1)', () => {
    expect(currentBalance(F1_ANCHOR, F1_TXS)).toMatchObject({
      postedCents: 200000,
      availableCents: 200000,
      asOf: '2026-12-01',
    });
  });

  it('R23.2: cash account with non-zero opening balance (F-2)', () => {
    expect(currentBalance(F2_ANCHOR, F2_TXS)).toMatchObject({
      postedCents: 6700,
      availableCents: 6700,
      asOf: '2026-12-05',
    });
  });

  it('R23.2: credit card stays negative (F-3)', () => {
    expect(currentBalance(F3_ANCHOR, F3_TXS)).toMatchObject({
      postedCents: -15000,
      availableCents: -15000,
      asOf: '2026-12-02',
    });
  });

  it('R23.2: positive pending interest raises available (H)', () => {
    expect(currentBalance(H_ANCHOR, H_TXS)).toEqual({
      postedCents: 1500000,
      availableCents: 1500120,
      pendingCount: 1,
      pendingCents: 120,
      asOf: '2026-12-10',
    });
  });
});

describe('previousAnchor / calibrationDiff（R23.3）', () => {
  const diffOf = (m: BalanceAnchor, anchors: BalanceAnchor[], txs: BalanceTx[]) =>
    calibrationDiff(m, previousAnchor(m, anchors), txs);

  it('R23.3: first manual balance has no previous anchor → null (E-1)', () => {
    expect(previousAnchor(E_M1, [E_M1])).toBeNull();
    expect(diffOf(E_M1, [E_M1], E_TXS)).toBeNull();
  });

  it('R23.3: matches → 0; anchor-day and pending transactions excluded (E-2)', () => {
    const anchors = [E_M1, E_M2];
    expect(previousAnchor(E_M2, anchors)).toBe(E_M1);
    expect(diffOf(E_M2, anchors, E_TXS)).toBe(0);
  });

  it('R23.3: off by -$30 (E-3)', () => {
    const anchors = [E_M1, E_M2, E_M3];
    expect(previousAnchor(E_M3, anchors)).toBe(E_M2);
    expect(diffOf(E_M3, anchors, E_TXS)).toBe(-3000);
  });

  it('R23.3: importing the missing e8 makes the diff disappear (E-4)', () => {
    const anchors = [E_M1, E_M2, E_M3];
    expect(diffOf(E_M3, anchors, E_TXS_WITH_E8)).toBe(0);
    expect(diffOf(E_M2, anchors, E_TXS_WITH_E8)).toBe(0);
  });

  it('R23.3: back-filled manual earlier than the latest PDF compares to PDF0 → +5000 (A-4)', () => {
    const m = manual('2026-10-20', 500000, '2026-12-10');
    const anchors = [...A_BATCH_ANCHORS, m];
    expect(previousAnchor(m, anchors)).toBe(A_PDF0);
    expect(diffOf(m, anchors, A_TXS)).toBe(5000);
  });

  it('R23.3: same-day PDF counts as the previous anchor → -345 (D-2)', () => {
    const anchors = [D_PDF, D_MANUAL];
    expect(previousAnchor(D_MANUAL, anchors)).toBe(D_PDF);
    expect(diffOf(D_MANUAL, anchors, D_TXS)).toBe(-345);
  });

  it('R23.3: opening-balance anchor has no previous anchor → null (F-1, H)', () => {
    expect(diffOf(F1_ANCHOR, [F1_ANCHOR], F1_TXS)).toBeNull();
    expect(diffOf(H_ANCHOR, [H_ANCHOR], H_TXS)).toBeNull();
  });
});

describe('lastCalibrationDiff（R23.3 卡片）', () => {
  it('R23.3: latest manual anchor diff, -3000 then 0 after importing e8 (E-3, E-4)', () => {
    expect(lastCalibrationDiff([E_M1, E_M2, E_M3], E_TXS)).toBe(-3000);
    expect(lastCalibrationDiff([E_M1, E_M2, E_M3], E_TXS_WITH_E8)).toBe(0);
  });

  it('R23.3: after deleting M3 the latest manual is M2 with diff 0 (E-5)', () => {
    expect(lastCalibrationDiff([E_M1, E_M2], E_TXS_WITH_E8)).toBe(0);
  });

  it('R23.3: shown even when the manual is not the current anchor (D-2, A-4)', () => {
    expect(lastCalibrationDiff([D_PDF, D_MANUAL], D_TXS)).toBe(-345);
    const m = manual('2026-10-20', 500000, '2026-12-10');
    expect(lastCalibrationDiff([...A_BATCH_ANCHORS, m], A_TXS)).toBe(5000);
  });

  it('R23.3: no manual anchor → null (A-1, B-1)', () => {
    expect(lastCalibrationDiff(A_BATCH_ANCHORS, A_TXS)).toBeNull();
    expect(lastCalibrationDiff([B_PDF1, B_PDF2], B_TXS)).toBeNull();
  });
});

describe('groupByPurpose（R23.5）', () => {
  // 场景 J：A-1、B-1、D-1、E-3、F-1、F-2、F-3、G-1、G-2、H 合在一起，ANZ Old 已归档
  const accounts = [
    { name: 'ANZ Joint', purpose: 'bills', isArchived: false, balance: currentBalance(A_PDF1, A_TXS) },
    { name: 'ANZ Male', purpose: 'everyday', isArchived: false, balance: currentBalance(E_M3, E_TXS) },
    { name: 'CBA Female', purpose: 'everyday', isArchived: false, balance: currentBalance(D_PDF, D_TXS) },
    { name: 'CBA Female Saver', purpose: 'emergency', isArchived: false, balance: currentBalance(H_ANCHOR, H_TXS) },
    { name: 'ANZ Plus Male', purpose: 'savings', isArchived: false, balance: currentBalance(B_PDF2, B_TXS) },
    { name: '现金（Male）', purpose: 'everyday', isArchived: false, balance: currentBalance(null, [c('2026-11-10', -2000)]) },
    { name: '现金（Female）', purpose: 'everyday', isArchived: false, balance: currentBalance(F2_ANCHOR, F2_TXS) },
    { name: 'ANZ Card', purpose: 'everyday', isArchived: false, balance: currentBalance(F3_ANCHOR, F3_TXS) },
    { name: 'Westpac 中转', purpose: 'everyday', isArchived: false, balance: currentBalance(F1_ANCHOR, F1_TXS) },
    { name: 'BOQ 中转', purpose: 'everyday', isArchived: false, balance: null },
    {
      name: 'ANZ Old',
      purpose: 'everyday',
      isArchived: true,
      balance: currentBalance(manual('2026-09-30', 100000, '2026-10-01'), []),
    },
  ] as const;

  const overview = groupByPurpose(accounts);

  it('R23.5: group order everyday, bills, emergency, savings; empty goal group hidden (J)', () => {
    expect(overview.groups.map((g) => g.purpose)).toEqual(['everyday', 'bills', 'emergency', 'savings']);
  });

  it('R23.5: group totals use available balance; no-balance accounts skipped, credit card negative included (J)', () => {
    expect(overview.groups.map((g) => g.availableCents)).toEqual([1476900, 557841, 1500120, 1079700]);
  });

  it('R23.5: top totals, pending flag and count of accounts without balance (J)', () => {
    expect(overview.availableCents).toBe(4614561);
    expect(overview.postedCents).toBe(4622090);
    expect(overview.hasPending).toBe(true);
    expect(overview.missingCount).toBe(2);
  });

  it('R23.5: archived ANZ Old not shown; accounts sorted by name within a group (J)', () => {
    expect(overview.groups[0].accounts.map((a) => a.name)).toEqual([
      'ANZ Card',
      'ANZ Male',
      'BOQ 中转',
      'CBA Female',
      'Westpac 中转',
      '现金（Female）',
      '现金（Male）',
    ]);
    expect(overview.groups.flatMap((g) => g.accounts).some((a) => a.name === 'ANZ Old')).toBe(false);
  });

  it('R23.5: group with only no-balance accounts is still shown, total 0', () => {
    const o = groupByPurpose([{ name: 'BOQ 中转', purpose: 'goal', isArchived: false, balance: null }]);
    expect(o.groups).toEqual([
      { purpose: 'goal', accounts: [expect.objectContaining({ name: 'BOQ 中转' })], availableCents: 0 },
    ]);
    expect(o.missingCount).toBe(1);
    expect(o.hasPending).toBe(false);
  });

  it('R23.5: no pending anywhere → hasPending false (B-1 only)', () => {
    const o = groupByPurpose([
      { name: 'ANZ Plus Male', purpose: 'savings', isArchived: false, balance: currentBalance(B_PDF2, B_TXS) },
    ]);
    expect(o.hasPending).toBe(false);
    expect(o.availableCents).toBe(1079700);
    expect(o.postedCents).toBe(1079700);
  });
});

describe('validateLink（R23.4）', () => {
  const H1 = 'h1';
  const anzMale = { id: 'anz-male', householdId: H1, bank: 'anz', isArchived: false } as const;
  const anzPlusMale = { id: 'anz-plus-male', householdId: H1, bank: 'anz_plus', isArchived: false } as const;
  const cbaFemale = { id: 'cba-female', householdId: H1, bank: 'cba', isArchived: false } as const;
  const cashFemale = { id: 'cash-female', householdId: H1, bank: 'cash', isArchived: false } as const;
  const anzOld = { id: 'anz-old', householdId: H1, bank: 'anz', isArchived: true } as const;
  const otherAnz = { id: 'other-anz', householdId: 'h2', bank: 'anz', isArchived: false } as const;

  it('R23.4: L1 ANZ Plus Male → ANZ Male passes', () => {
    expect(validateLink(anzPlusMale, anzMale)).toBeNull();
  });

  it('R23.4: L2 cannot link to itself', () => {
    expect(validateLink(anzMale, anzMale)).toBe('不能关联自己');
  });

  it('R23.4: L3 other household → not found (does not reveal household)', () => {
    expect(validateLink(anzMale, otherAnz)).toBe('找不到这个账户');
    expect(validateLink(anzMale, null)).toBe('找不到这个账户');
  });

  it('R23.4: L4 archived target', () => {
    expect(validateLink(anzMale, anzOld)).toBe('不能关联已归档的账户');
  });

  it('R23.4: L5 cash account cannot link', () => {
    expect(validateLink(cashFemale, cbaFemale)).toBe('现金账户不能关联别的账户');
  });

  it('R23.4: L6 cannot link to a cash account', () => {
    expect(validateLink(cbaFemale, cashFemale)).toBe('不能关联现金账户');
  });

  it('R23.4: L7 mutual links allowed', () => {
    expect(validateLink(anzMale, anzPlusMale)).toBeNull();
  });

  it('R23.4: order — cash account linking to itself reports self first', () => {
    expect(validateLink(cashFemale, cashFemale)).toBe('不能关联自己');
  });

  it('R23.4: order — archived before cash checks', () => {
    expect(validateLink(cashFemale, { ...cbaFemale, isArchived: true })).toBe('不能关联已归档的账户');
  });
});

// ---------- R24.4 某天结束时的余额（fixtures/cases/15-monthly-conditions.md 场景 D） ----------

describe('balanceAt（R23、R24.4）', () => {
  const PLUS_ANCHORS = [pdf('2026-10-31', 1000000, '2026-11-02'), pdf('2026-11-30', 1052500, '2026-12-02')];
  const PLUS_TXS = [c('2026-11-10', 50000), c('2026-11-30', 2500)];
  const SAVER_ANCHORS = [manual('2026-11-30', 1500000, '2026-12-01')];
  const SAVER_TXS = [c('2026-11-30', 900), c('2026-12-06', 50000), c('2026-12-10', 120), c('2026-12-15', -120), c('2026-12-16', -500)];

  it('R24.4 D-1: anchor on the date itself, anchor-day transactions not added again', () => {
    expect(balanceAt(PLUS_ANCHORS, PLUS_TXS, '2026-10-31')).toBe(1000000);
    expect(balanceAt(PLUS_ANCHORS, PLUS_TXS, '2026-11-30')).toBe(1052500);
  });

  it('R24.4 D-2: no transactions after the anchor', () => {
    expect(balanceAt(PLUS_ANCHORS, PLUS_TXS, '2026-12-28')).toBe(1052500);
  });

  it('R24.4: between anchors uses the earlier one plus confirmed up to date', () => {
    expect(balanceAt(PLUS_ANCHORS, PLUS_TXS, '2026-11-10')).toBe(1050000);
    expect(balanceAt(PLUS_ANCHORS, PLUS_TXS, '2026-11-29')).toBe(1050000);
  });

  it('R24.4 D-3: later anchors are not used', () => {
    const anchors = [...PLUS_ANCHORS, pdf('2026-12-31', 925100, '2027-01-03')];
    const txs = [...PLUS_TXS, c('2026-12-02', -120000), c('2026-12-16', -10000), c('2026-12-31', 2600)];
    expect(balanceAt(anchors, txs, '2026-12-31')).toBe(925100);
    expect(balanceAt(anchors, txs, '2026-12-30')).toBe(922500);
  });

  it('R24.4 D-4: no anchor on or before date → null', () => {
    expect(balanceAt(SAVER_ANCHORS, SAVER_TXS, '2026-10-31')).toBeNull();
    expect(balanceAt([], [], '2026-12-31')).toBeNull();
  });

  it('R24.4 D-5: manual anchor, pending not counted', () => {
    expect(balanceAt(SAVER_ANCHORS, SAVER_TXS, '2026-12-28')).toBe(1549500);
    expect(balanceAt(SAVER_ANCHORS, [...SAVER_TXS, p('2026-12-20', -800)], '2026-12-28')).toBe(1549500);
  });

  it('R23.1: same-day anchors pick PDF over manual', () => {
    const anchors = [manual('2026-11-30', 111, '2026-12-05'), pdf('2026-11-30', 222, '2026-12-01')];
    expect(balanceAt(anchors, [], '2026-12-01')).toBe(222);
  });
});
