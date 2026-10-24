import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { readFixture } from '../../../tests/helpers/fixtures';
import type { MemberSource, ProcessedRow, TransferStatus } from '../rules/types';
import { processFile } from './process';

// 期望值来自 fixtures/README.md "期望结果：joint-2026-09.csv" 和 "期望结果：导入 cba/female-2026-09.csv"
// 每个文件单独处理（R12 第 2 步、第 5 步里"新交易"的部分），不含 R6.2 配对、R6.3 建议

const h = buildTestHousehold();
const joint = h.account('ANZ Joint');
const female = h.account('CBA Female');

type Expected = {
  date: string;
  amountCents: number;
  merchant: string;
  card: string | null;
  category: string; // h.category 路径，系统分类用名字
  member: string;
  source: MemberSource;
  transfer?: { status: TransferStatus; account: string };
};

function rows(result: ReturnType<typeof processFile>): ProcessedRow[] {
  if (!result.ok) throw new Error(`处理失败: ${result.message}`);
  return result.rows;
}

// R7：系统分类（1、2、4 步）写 system，用户规则写 rule
function sourceOf(path: string) {
  return h.category(path).systemKey ? 'system' : 'rule';
}

function check(got: ProcessedRow[], expected: Expected[], accountId: string) {
  expect(got).toHaveLength(expected.length);
  got.forEach((r, i) => {
    const e = expected[i];
    const cat = h.category(e.category);
    expect(
      {
        accountId: r.accountId,
        date: r.date,
        amountCents: r.amountCents,
        merchant: r.merchant,
        cardLast4: r.cardLast4,
        categoryId: r.categoryId,
        categorySource: r.categorySource,
        isPreTax: r.isPreTax,
        memberId: r.memberId,
        memberSource: r.memberSource,
        transferStatus: r.transferStatus,
        transferAccountId: r.transferAccountId,
      },
      `#${i + 1}`,
    ).toEqual({
      accountId,
      date: e.date,
      amountCents: e.amountCents,
      merchant: e.merchant,
      cardLast4: e.card,
      categoryId: cat.id,
      categorySource: sourceOf(e.category),
      isPreTax: cat.isPreTaxDefault,
      memberId: h.member(e.member).id,
      memberSource: e.source,
      transferStatus: e.transfer?.status ?? 'none',
      transferAccountId: e.transfer ? h.account(e.transfer.account).id : null,
    });
  });
}

const NO_LONG_DIGITS = /\d{8,}/;

// dedupeKey 是 sha256 hex，本身可能碰巧有 8 位数字，而且不是账号，不查
function stringFields(r: ProcessedRow): string[] {
  return Object.entries(r)
    .filter(([key, v]) => key !== 'dedupeKey' && typeof v === 'string')
    .map(([, v]) => v as string);
}

describe('processFile：joint-2026-09.csv（ANZ Joint）', () => {
  const text = readFixture('anz/joint-2026-09.csv');
  const got = rows(processFile(text, joint, h));

  // fixtures/README.md 主表 19 行
  const EXPECTED: Expected[] = [
    {
      date: '2026-09-30',
      amountCents: 500,
      merchant: 'REVERSAL OF ACCOUNT SERVICING FEE MINIMUM $2000 IN DEPOSITS RECEIVED',
      card: null,
      category: 'Bank fees',
      member: 'Home',
      source: 'account',
    },
    {
      date: '2026-09-30',
      amountCents: -500,
      merchant: 'ACCOUNT SERVICING FEE',
      card: null,
      category: 'Bank fees',
      member: 'Home',
      source: 'account',
    },
    {
      date: '2026-09-29',
      amountCents: -9840,
      merchant: 'BPAY SEENE',
      card: null,
      category: 'Home & utilities / Electricity',
      member: 'Home',
      source: 'category',
    },
    {
      date: '2026-09-28',
      amountCents: -450,
      merchant: 'GONG CHA & HO/SPENCER ST MELBOURNE',
      card: '1111',
      category: 'Entertainment & eat-out / Bubble tea',
      member: 'Male',
      source: 'card',
    },
    {
      date: '2026-09-28',
      amountCents: -450,
      merchant: 'GONG CHA & HO/SPENCER ST MELBOURNE',
      card: '1111',
      category: 'Entertainment & eat-out / Bubble tea',
      member: 'Male',
      source: 'card',
    },
    {
      date: '2026-09-25',
      amountCents: -15000,
      merchant: 'ATM CBA HAWTHORN',
      card: null,
      category: 'Cash withdrawal',
      member: 'Home',
      source: 'account',
    },
    {
      date: '2026-09-22',
      amountCents: 8000,
      merchant: 'PAYID DEPOSIT REF DINNER SPLIT',
      card: null,
      category: 'Uncategorised',
      member: 'Home',
      source: 'account',
    },
    {
      date: '2026-09-22',
      amountCents: -6120,
      merchant: 'POCHANA MELBOURNE MELBOURNE',
      card: null,
      category: 'Entertainment & eat-out / Restaurants',
      member: 'Home',
      source: 'account',
    },
    {
      date: '2026-09-20',
      amountCents: -3875,
      merchant: 'CROWN ASIAN SPENCER DOCKLANDS',
      card: '2222',
      category: 'Groceries / Supermarket',
      member: 'Home',
      source: 'category',
    },
    {
      date: '2026-09-18',
      amountCents: 4580,
      merchant: 'MEDICARE BENEFIT',
      card: null,
      category: 'Personal & medical / Other',
      member: 'Home',
      source: 'account',
    },
    {
      date: '2026-09-15',
      amountCents: -50000,
      merchant: 'TRANSFER TO ****0003',
      card: null,
      category: 'Internal transfer',
      member: 'Home',
      source: 'account',
      transfer: { status: 'auto', account: 'CBA Female' },
    },
    {
      date: '2026-09-12',
      amountCents: -2500,
      merchant: 'CHARGEFOX PTY LTD NORTH MELBOUR',
      card: null,
      category: 'Transport & auto / Petrol / EV charging',
      member: 'Home',
      source: 'account',
    },
    {
      date: '2026-09-10',
      amountCents: 150,
      merchant: 'MELB ASIAN MARKET',
      card: null,
      category: 'Groceries / Supermarket',
      member: 'Home',
      source: 'category',
    },
    {
      date: '2026-09-10',
      amountCents: -6230,
      merchant: 'MELB ASIAN MARKET',
      card: null,
      category: 'Groceries / Supermarket',
      member: 'Home',
      source: 'category',
    },
    {
      date: '2026-09-08',
      amountCents: -1200,
      merchant: 'UNKNOWN SHOP PTY LTD MELBOURNE',
      card: '3333',
      category: 'Uncategorised',
      member: 'Home',
      source: 'account',
    },
    {
      date: '2026-09-05',
      amountCents: -2715,
      merchant: 'EASI AU ****2605',
      card: '2222',
      category: 'Uncategorised',
      member: 'Female',
      source: 'card',
    },
    {
      date: '2026-09-03',
      amountCents: 200000,
      merchant: 'TRANSFER FROM ****0002',
      card: null,
      category: 'Internal transfer',
      member: 'Home',
      source: 'account',
      transfer: { status: 'auto', account: 'ANZ Male' },
    },
    {
      date: '2026-09-02',
      amountCents: 30000,
      merchant: 'TRANSFER FROM ****9999',
      card: null,
      category: 'Uncategorised',
      member: 'Home',
      source: 'account',
    },
    {
      date: '2026-09-01',
      amountCents: -5840,
      merchant: 'COLES 0559 MELBOURNE',
      card: '1111',
      category: 'Groceries / Supermarket',
      member: 'Home',
      source: 'category',
    },
  ];

  it('R12: all columns of the 19 rows match fixtures/README.md', () => {
    check(got, EXPECTED, joint.id);
  });

  it('R4.1: GONG CHA #4, #5 get occurrence 1 and 2 and different keys; others are 1', () => {
    expect(got.map((r) => r.occurrence)).toEqual(got.map((_, i) => (i === 4 ? 2 : 1)));
    expect(new Set(got.map((r) => r.dedupeKey)).size).toBe(19);
  });

  it('R12: rowIndex, balance (ANZ has none), masked raw description', () => {
    expect(got.map((r) => r.rowIndex)).toEqual(got.map((_, i) => i + 1));
    expect(got.every((r) => r.balanceCents === null)).toBe(true);
    expect(got[10].rawDescription).toBe('ANZ M-BANKING FUNDS TFER TRANSFER 100002  TO  ****0003');
  });

  it('R2.3: no string field has 8+ consecutive digits', () => {
    for (const r of got) for (const s of stringFields(r)) expect(s).not.toMatch(NO_LONG_DIGITS);
    // fixtures/README.md "入库检查"
    const all = JSON.stringify(got);
    for (const secret of ['400000002', '012345400000003', '499999999', '280672605']) {
      expect(all).not.toContain(secret);
    }
  });

  it('R12: processing the same file twice gives identical output', () => {
    expect(rows(processFile(text, joint, h))).toEqual(got);
  });
});

describe('processFile：cba/female-2026-09.csv（CBA Female）', () => {
  const got = rows(processFile(readFixture('cba/female-2026-09.csv'), female, h));

  // fixtures/README.md CBA 表 20 行。#10 单独处理时是 Uncategorised（配对在 M2-9 测）
  const EXPECTED: Expected[] = [
    {
      date: '2026-09-30',
      amountCents: 1234,
      merchant: 'CREDIT INTEREST',
      card: null,
      category: 'Income / Interest',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-28',
      amountCents: -90000,
      merchant: 'BPAY TAX OFFICE PAYMENTS',
      card: null,
      category: 'Income / Tax (ATO)',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-25',
      amountCents: 300000,
      merchant: 'FAST TRANSFER FROM ACME TRADING PTY LTD INVOICE 0925',
      card: null,
      category: 'Uncategorised',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-24',
      amountCents: 100000,
      merchant: 'TRANSFER FROM XX7777 HOME',
      card: null,
      category: 'Internal transfer',
      member: 'Female',
      source: 'account',
      transfer: { status: 'auto', account: 'CBA Female Saver' },
    },
    {
      date: '2026-09-22',
      amountCents: -45560,
      merchant: 'BPAY DEFT PAYMENTS',
      card: null,
      category: 'Home & utilities / Body corporate fees',
      member: 'Home',
      source: 'category',
    },
    {
      date: '2026-09-20',
      amountCents: 400,
      merchant: 'CBA YELLO HLPCKG CSHBK',
      card: null,
      category: 'Income / Other',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-19',
      amountCents: 3860,
      merchant: 'DIRECT CREDIT 002221 MCARE BENEFITS ****6789 ABCD',
      card: null,
      category: 'Personal & medical / Other',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-16',
      amountCents: -6490,
      merchant: 'CROWN ASIAN SPENCER DOCKLANDS',
      card: '5555',
      category: 'Groceries / Supermarket',
      member: 'Home',
      source: 'category',
    },
    {
      date: '2026-09-16',
      amountCents: -29840,
      merchant: 'DIRECT DEBIT 000793 BUPA AUSTRALIA ****4000',
      card: null,
      category: 'Insurance & financial / Personal & life insurance',
      member: 'Home',
      source: 'category',
    },
    {
      date: '2026-09-16',
      amountCents: 50000,
      merchant: 'FAST TRANSFER FROM TEST HOLDER JOINT',
      card: null,
      category: 'Uncategorised',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-15',
      amountCents: -2280,
      merchant: 'KIS HAIR MELBOURNE',
      card: '4444',
      category: 'Personal & medical / Hair & beauty',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-12',
      amountCents: -300,
      merchant: 'TOWER SUSHI & GOURM MELBOURNE',
      card: null,
      category: 'Uncategorised',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-12',
      amountCents: -300,
      merchant: 'TOWER SUSHI & GOURM MELBOURNE',
      card: null,
      category: 'Uncategorised',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-10',
      amountCents: -7500,
      merchant: 'LIGHTNING BROADBAND',
      card: null,
      category: 'Home & utilities / Internet',
      member: 'Home',
      source: 'category',
    },
    {
      date: '2026-09-08',
      amountCents: 2250,
      merchant: 'FAST TRANSFER FROM OTHER FRIEND DINNER',
      card: null,
      category: 'Uncategorised',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-08',
      amountCents: -4500,
      merchant: 'TRANSFER TO TEST FRIEND EAT EAT',
      card: null,
      category: 'Entertainment & eat-out / Restaurants',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-05',
      amountCents: -680,
      merchant: 'OVERLAY COFFEE MELBOURNE',
      card: '5555',
      category: 'Entertainment & eat-out / Coffee & tea',
      member: 'Female',
      source: 'account',
    },
    {
      date: '2026-09-03',
      amountCents: -7135,
      merchant: 'BPAY SEENE',
      card: null,
      category: 'Home & utilities / Electricity',
      member: 'Home',
      source: 'category',
    },
    {
      date: '2026-09-02',
      amountCents: -148000,
      merchant: 'LOAN REPAYMENT LN REPAY ****6789',
      card: null,
      category: 'Home & utilities / Mortgage',
      member: 'Home',
      source: 'category',
    },
    {
      date: '2026-09-01',
      amountCents: 41000,
      merchant: 'SALARY EXAMPLE SCHOOL WAGES ****2026',
      card: null,
      category: 'Income / Salary',
      member: 'Female',
      source: 'account',
    },
  ];

  it('R12: all columns of the 20 rows match fixtures/README.md', () => {
    check(got, EXPECTED, female.id);
  });

  it('R7: #1 Credit Interest is pre-tax, #20 Salary is not', () => {
    expect(got[0].isPreTax).toBe(true);
    expect(got[19].isPreTax).toBe(false);
  });

  it('R4.1: #12, #13 get occurrence 1, 2 and different keys; balance is kept', () => {
    expect([got[11].occurrence, got[12].occurrence]).toEqual([1, 2]);
    expect(got[11].dedupeKey).not.toBe(got[12].dedupeKey);
    expect(got.every((r) => r.balanceCents !== null)).toBe(true);
    expect(got[0].balanceCents).toBe(1156159);
  });

  it('R2.3: no string field has 8+ consecutive digits', () => {
    for (const r of got) for (const s of stringFields(r)) expect(s).not.toMatch(NO_LONG_DIGITS);
    const all = JSON.stringify(got);
    for (const secret of [
      '5512345678901234',
      '12345678901234567890',
      '111122223333444000',
      '123456789',
      '01092026',
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('processFile：失败', () => {
  it('R1: invalid file fails as a whole with line number, no rows', () => {
    const r = processFile(readFixture('anz/invalid-date.csv'), joint, h);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.line).toBe(1);
  });

  it('R1: account that cannot import CSV (anz_plus) fails', () => {
    expect(
      processFile(readFixture('anz/joint-2026-09.csv'), h.account('ANZ Plus Male'), h).ok,
    ).toBe(false);
  });
});
