import { beforeAll, describe, expect, it } from 'vitest';
import {
  readFixture,
  readStatementFixture,
  toStatementLines,
} from '../../../tests/helpers/fixtures';
import { normalizeDescription } from '@/lib/rules/dedupe';
import type { ParsedRow } from '@/lib/rules/types';
import { identifyStatementAccount, parseAnzStatement, statementPeriod } from './anz-statement';
import { parseBankCsv } from './index';

// 期望值来自 business-rules.md R1C、R1C.1 和 fixtures/README.md "ANZ 对账单用例"
// fixture 是编的：ANZ Joint，number_suffix 0001（fixtures/README.md 账户表）

const SUFFIX = '0001';
const JOINT_TEXT = readFixture('anz-statement/joint-2026-09.txt');

// 在 joint-2026-09.txt 上改一处再解析。from 必须正好出现一次，免得改错地方测试还通过
function parseEdited(from: string, to: string, text = JOINT_TEXT, suffix: string | null = SUFFIX) {
  expect(text.split(from)).toHaveLength(2);
  return parseAnzStatement(toStatementLines(text.replace(from, to)), suffix);
}

type Result = ReturnType<typeof parseAnzStatement>;
type Success = Extract<Result, { ok: true }>;

function expectFailure(result: Result) {
  if (result.ok) throw new Error('期望解析失败，实际成功了');
  return result;
}

function expectSuccess(result: Result): Success {
  if (!result.ok) throw new Error(`期望解析成功，实际失败了: ${result.message}`);
  return result;
}

// 不管顺序比较：排序后的 "date|amount|description"
function keyed(rows: { date: string; amountCents: number; description: string }[]) {
  return rows.map((r) => `${r.date}|${r.amountCents}|${r.description}`).sort();
}

describe('parseAnzStatement（R1C）', () => {
  describe('joint-2026-09.txt（R1C.1）', () => {
    let result: Success;
    let csv: ParsedRow[];
    beforeAll(() => {
      result = expectSuccess(parseAnzStatement(readStatementFixture('joint-2026-09.txt'), SUFFIX));
      const parsed = parseBankCsv('anz', readFixture('anz/joint-2026-09.csv'));
      if (!parsed.ok) throw new Error(parsed.message);
      csv = parsed.rows;
    });

    it('R1C.1: parses 19 rows', () => {
      expect(result.rows).toHaveLength(19);
    });

    it('R1C.1: (date, amountCents, normalizedDescription) equal the CSV rows, ignoring order', () => {
      const norm = (rows: ParsedRow[]) =>
        keyed(rows.map((r) => ({ ...r, description: normalizeDescription(r.description) })));
      expect(norm(result.rows)).toEqual(norm(csv));
    });

    it('R1C: descriptions equal the CSV exactly when the CSV has no repeated spaces (continuation lines joined with one space)', () => {
      const singleSpaced = csv.filter((r) => !/\s{2,}/.test(r.description));
      expect(singleSpaced.length).toBeGreaterThan(10);
      const pdf = new Set(keyed(result.rows));
      for (const row of keyed(singleSpaced)) expect(pdf).toContain(row);
    });

    it('R1C: multi-line descriptions are joined like the CSV', () => {
      const descriptions = result.rows.map((r) => r.description);
      expect(descriptions).toContain(
        'VISA DEBIT PURCHASE CARD 1111 GONG CHA & HO/SPENCER ST MELBOURNE',
      );
      expect(descriptions).toContain(
        'REVERSAL OF ACCOUNT SERVICING FEE MINIMUM $2000 IN DEPOSITS RECEIVED',
      );
    });

    it('R1C: EFFECTIVE DATE lines are not part of any description', () => {
      for (const row of result.rows) expect(row.description).not.toMatch(/EFFECTIVE DATE/);
    });

    it('R1C: OPENING BALANCE, page totals, headers and footer text are not rows', () => {
      for (const row of result.rows) {
        expect(row.description).not.toMatch(/OPENING BALANCE|TOTALS AT END|Page \d|statement/i);
      }
    });

    it('R1C: reads the period as (periodFrom, periodTo] and the summary balances', () => {
      expect(result.periodFrom).toBe('2026-08-31');
      expect(result.periodTo).toBe('2026-09-30');
      expect(result.openingCents).toBe(500000);
      expect(result.closingCents).toBe(638510);
    });

    it('R1C: rows keep file order (oldest first), rowIndex counts from 1, balance is not output', () => {
      expect(result.rows[0]).toEqual({
        date: '2026-09-01',
        amountCents: -5840,
        description: 'VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE',
        balanceCents: null,
        rowIndex: 1,
      });
      expect(result.rows.map((r) => r.rowIndex)).toEqual(
        Array.from({ length: 19 }, (_, i) => i + 1),
      );
      expect(result.rows.at(-1)?.date).toBe('2026-09-30');
      for (const row of result.rows) expect(row.balanceCents).toBeNull();
    });

    it('R1C: withdrawals are negative, deposits positive, thousands separators removed', () => {
      expect(result.rows.find((r) => r.date === '2026-09-03')?.amountCents).toBe(200000);
      expect(result.rows.find((r) => r.date === '2026-09-15')?.amountCents).toBe(-50000);
    });

    it('R1C: result does not contain the full account number', () => {
      expect(JSON.stringify(result)).not.toMatch(/1234-?50001/);
    });
  });

  it('R1C: joint-2026-10.txt with no transactions is ok, opening equals closing', () => {
    const result = expectSuccess(
      parseAnzStatement(readStatementFixture('joint-2026-10.txt'), SUFFIX),
    );
    expect(result.rows).toEqual([]);
    expect(result.periodFrom).toBe('2026-09-30');
    expect(result.periodTo).toBe('2026-10-31');
    expect(result.openingCents).toBe(638510);
    expect(result.closingCents).toBe(638510);
  });

  it('R1C: joint-2026-11-gap.txt parses its 2 rows (the gap is R12.2, not a parse error)', () => {
    const result = expectSuccess(
      parseAnzStatement(readStatementFixture('joint-2026-11-gap.txt'), SUFFIX),
    );
    expect(result.rows.map((r) => [r.date, r.amountCents])).toEqual([
      ['2026-11-05', -3260],
      ['2026-11-20', 6000],
    ]);
    expect(result.openingCents).toBe(648510);
  });

  describe('账号尾号', () => {
    it('R1C: wrong-account.txt (ends with 0002) fails without the full account number in the message', () => {
      const failure = expectFailure(
        parseAnzStatement(readStatementFixture('wrong-account.txt'), SUFFIX),
      );
      expect(failure.message).toContain('这份对账单不是这个账户的');
      expect(failure.message).not.toMatch(/1234|50002|\d{8,}/);
      expect(JSON.stringify(failure)).not.toMatch(/1234-?50002/);
    });

    it('R1C: account without number_suffix fails and asks to fill it in account settings', () => {
      const failure = expectFailure(
        parseAnzStatement(readStatementFixture('joint-2026-09.txt'), null),
      );
      expect(failure.message).toContain('账户设置');
    });

    it('R1C: a 6-digit suffix matching the end of the account number is accepted', () => {
      expectSuccess(parseAnzStatement(readStatementFixture('joint-2026-09.txt'), '450001'));
    });
  });

  describe('年份', () => {
    it('R1C: year-rollover.txt puts DEC in 2026 and JAN in 2027', () => {
      const result = expectSuccess(
        parseAnzStatement(readStatementFixture('year-rollover.txt'), SUFFIX),
      );
      expect(result.rows.map((r) => r.amountCents)).toEqual([-4500, -1250, 20000, -3000]);
      expect(result.periodFrom).toBe('2026-12-15');
      expect(result.periodTo).toBe('2027-01-15');
      expect(result.rows.map((r) => r.date)).toEqual([
        '2026-12-20',
        '2026-12-28',
        '2027-01-03',
        '2027-01-10',
      ]);
    });

    it('R1C: without the year-only line, the month drop alone still gives 2027', () => {
      const text = readFixture('anz-statement/year-rollover.txt');
      const result = expectSuccess(parseEdited('2027  blank\n', '', text));
      expect(result.rows.map((r) => r.date)).toEqual([
        '2026-12-20',
        '2026-12-28',
        '2027-01-03',
        '2027-01-10',
      ]);
    });

    it('R1C: the year-only line sets the year and does not add another year on the month drop after it', () => {
      const text = readFixture('anz-statement/year-rollover.txt');
      const result = expectSuccess(parseEdited('2027  blank\n', '2027  blank  blank\n', text));
      expect(result.rows.map((r) => r.date)).toEqual([
        '2026-12-20',
        '2026-12-28',
        '2027-01-03',
        '2027-01-10',
      ]);
    });

    it('R1C: a year-only line that puts rows outside the period fails', () => {
      const failure = expectFailure(parseEdited('2026  blank  blank', '2025  blank  blank'));
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(1);
    });

    it('R1C: a row after periodTo fails', () => {
      const failure = expectFailure(
        parseEdited('30 SEP  ACCOUNT SERVICING FEE', '01 OCT  ACCOUNT SERVICING FEE'),
      );
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(8);
    });

    it('R1C: first-day.txt fails with the "first day of the period" message', () => {
      const failure = expectFailure(
        parseAnzStatement(readStatementFixture('first-day.txt'), SUFFIX),
      );
      expect(failure.message).toContain('账期第一天有交易，R1C 对账期的假设不对');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(1);
    });
  });

  describe('三项检查', () => {
    it('R1C: broken-balance.txt fails at page 2, transaction 3', () => {
      const failure = expectFailure(
        parseAnzStatement(readStatementFixture('broken-balance.txt'), SUFFIX),
      );
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(3);
    });

    it('R1C: closing balance one cent off from the last row fails', () => {
      expectFailure(parseEdited('$\n6,385.10\nNeed', '$\n6,385.11\nNeed'));
    });

    it('R1C: summary Total Withdrawals one cent off fails', () => {
      expectFailure(parseEdited('$\n1,047.20\nClosing', '$\n1,047.21\nClosing'));
    });

    it('R1C: summary Total Deposits one cent off fails', () => {
      expectFailure(parseEdited('012-345  $\n2,432.30', '012-345  $\n2,432.31'));
    });

    it('R1C: OPENING BALANCE row not equal to the summary opening balance fails', () => {
      expectFailure(parseEdited('OPENING BALANCE  5,000.00', 'OPENING BALANCE  5,000.01'));
    });
  });

  describe('交易行', () => {
    it('R1C: a row with both withdrawal and deposit amounts fails', () => {
      const failure = expectFailure(
        parseEdited('DINNER SPLIT  blank  80.00', 'DINNER SPLIT  1.00  80.00'),
      );
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(3);
    });

    it('R1C: a row with both withdrawal and deposit blank fails', () => {
      const failure = expectFailure(
        parseEdited('MEDICARE BENEFIT  blank  45.80', 'MEDICARE BENEFIT  blank  blank'),
      );
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(10);
    });

    it('R1C: a row whose balance is not an amount fails', () => {
      const failure = expectFailure(
        parseEdited(
          'MEDICARE BENEFIT  blank  45.80  6,662.45',
          'MEDICARE BENEFIT  blank  45.80  blank',
        ),
      );
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(10);
    });
  });

  describe('真实对账单的格式（R1C，2026-10-29）', () => {
    it('R1C: summary amount on the same line as the label also works', () => {
      const result = expectSuccess(
        parseEdited(
          'Opening Balance:\nTEST HOUSEHOLD\n$\nJOINT ACCOUNT  5,000.00',
          'Opening Balance  $5,000.00',
        ),
      );
      expect(result.openingCents).toBe(500000);
    });

    it('R1C: summary amount more than 4 lines after the label fails', () => {
      expectFailure(parseEdited('$\n6,385.10\nNeed', '$\nA\nB\nC\n6,385.10\nNeed'));
    });

    it('R1C: account number on the same line as the label also works', () => {
      expectSuccess(
        parseEdited(
          'Account Number\nTotal Withdrawals:\n1234-50001',
          'Account Number  1234-50001\nTotal Withdrawals:',
        ),
      );
    });

    it('R1C: OPENING BALANCE with blank blank before the balance also works', () => {
      expectSuccess(
        parseEdited('OPENING BALANCE  5,000.00', 'OPENING BALANCE  blank  blank  5,000.00'),
      );
    });

    it('R1C: a row ending in only amount and balance is a withdrawal when the balance goes down', () => {
      const original = expectSuccess(parseAnzStatement(toStatementLines(JOINT_TEXT), SUFFIX));
      const result = expectSuccess(parseEdited('58.40  blank  4,941.60', '58.40  4,941.60'));
      expect(result.rows).toEqual(original.rows);
    });

    it('R1C: a row ending in only amount and balance is a deposit when the balance goes up', () => {
      const original = expectSuccess(parseAnzStatement(toStatementLines(JOINT_TEXT), SUFFIX));
      const result = expectSuccess(parseEdited('blank  300.00  5,241.60', '300.00  5,241.60'));
      expect(result.rows).toEqual(original.rows);
    });

    it('R1C: a row ending in only amount and balance fails when neither direction gives the balance', () => {
      const failure = expectFailure(parseEdited('58.40  blank  4,941.60', '58.40  4,941.61'));
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(1);
    });

    it('R1C: blank before TOTALS AT END OF PAGE is skipped, not joined to the last description', () => {
      expect(JOINT_TEXT).toContain('blank  TOTALS AT END OF PAGE');
      const result = expectSuccess(parseAnzStatement(toStatementLines(JOINT_TEXT), SUFFIX));
      expect(result.rows[9].description).toBe('EFTPOS MEDICARE BENEFIT');
    });
  });

  describe('标题（R1C，2026-10-29 改）', () => {
    // 真实的 Progress Saver 对账单标题里没有 ANZ，ANZ 只在别的行里出现
    const PROGRESS_SAVER_TEXT = JOINT_TEXT.replaceAll(
      'ANZ ACCESS ADVANTAGE STATEMENT',
      'PROGRESS SAVER ACCOUNT STATEMENT',
    );

    it('R1C: title without ANZ (PROGRESS SAVER ACCOUNT STATEMENT) parses the same rows', () => {
      expect(PROGRESS_SAVER_TEXT).not.toBe(JOINT_TEXT);
      const original = expectSuccess(parseAnzStatement(toStatementLines(JOINT_TEXT), SUFFIX));
      const result = expectSuccess(
        parseAnzStatement(toStatementLines(PROGRESS_SAVER_TEXT), SUFFIX),
      );
      expect(result.rows).toEqual(original.rows);
    });

    it('R1C: the title line on later pages is skipped, not joined to a description', () => {
      const original = expectSuccess(parseAnzStatement(toStatementLines(JOINT_TEXT), SUFFIX));
      const result = expectSuccess(
        parseAnzStatement(toStatementLines(PROGRESS_SAVER_TEXT), SUFFIX),
      );
      expect(result.rows.map((r) => r.description)).toEqual(
        original.rows.map((r) => r.description),
      );
    });

    it('R1C: fails when a STATEMENT title exists but no line mentions ANZ', () => {
      const text = PROGRESS_SAVER_TEXT.replace(/\bANZ\b/gi, 'XYZ');
      const failure = expectFailure(parseAnzStatement(toStatementLines(text), SUFFIX));
      expect(failure.message).toBe('找不到对账单标题，这不像 ANZ 对账单');
    });

    it('R1C: STATEMENT NUMBER and sentences ending in STATEMENT. are not titles', () => {
      const text = JOINT_TEXT.replace(/^ANZ ACCESS ADVANTAGE STATEMENT$/gm, '').concat(
        '\nPLEASE CHECK THE ENTRIES REGARDING ANY ERRORS ON THIS STATEMENT.\n',
      );
      expect(text).toContain('STATEMENT NUMBER 9');
      const failure = expectFailure(parseAnzStatement(toStatementLines(text), SUFFIX));
      expect(failure.message).toBe('找不到对账单标题，这不像 ANZ 对账单');
    });

    it('R1C: identifyStatementAccount accepts the Progress Saver title', () => {
      expect(
        identifyStatementAccount(toStatementLines(PROGRESS_SAVER_TEXT), [
          { id: 'saver', numberSuffix: SUFFIX },
        ]),
      ).toEqual({ ok: true, accountId: 'saver' });
    });
  });

  describe('表头', () => {
    it.each([
      ['the ANZ ... STATEMENT title', /^ANZ ACCESS ADVANTAGE STATEMENT$/gm],
      ['the period', /^\d{2} [A-Z]+ \d{4} TO .*$/gm],
      ['the account number', /^Account Number.*$/gm],
      ['Opening Balance', /^Opening Balance:$/gm],
      ['Closing Balance', /^Closing Balance:$/gm],
      ['Total Deposits', /Total Deposits:/g],
      ['Total Withdrawals', /^Total Withdrawals:$/gm],
    ])('R1C: fails when %s is missing', (_label, pattern) => {
      const text = JOINT_TEXT.replace(pattern, '');
      expect(text).not.toBe(JOINT_TEXT);
      expectFailure(parseAnzStatement(toStatementLines(text), SUFFIX));
    });
  });
});

// M6.6-6：页面显示纸面账期。批次存的是 (periodFrom, periodTo]，date_from = periodFrom 的第二天
describe('statementPeriod（R1C）', () => {
  it('R1C: date_from 2026-09-01 → statement period 2026-08-31 to 2026-09-30', () => {
    expect(statementPeriod('2026-09-01', '2026-09-30')).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    });
  });

  it('R1C: crosses a year', () => {
    expect(statementPeriod('2026-12-16', '2027-01-15')).toEqual({
      from: '2026-12-15',
      to: '2027-01-15',
    });
  });
});

// M6.6-6b：用对账单的账号认账户。accounts 是调用方筛好的没归档的 ANZ 账户
describe('identifyStatementAccount（R1C 自动认账户）', () => {
  const JOINT = { id: 'joint', numberSuffix: '0001' };
  const MALE = { id: 'male', numberSuffix: '0002' };

  it('R1C / S11: joint-2026-09.txt → the account whose suffix matches', () => {
    expect(
      identifyStatementAccount(readStatementFixture('joint-2026-09.txt'), [MALE, JOINT]),
    ).toEqual({ ok: true, accountId: 'joint' });
  });

  it('R1C / S12: wrong-account.txt (…0002) → ANZ Male', () => {
    expect(
      identifyStatementAccount(readStatementFixture('wrong-account.txt'), [JOINT, MALE]),
    ).toEqual({ ok: true, accountId: 'male' });
  });

  it('R1C: a longer suffix matches too', () => {
    expect(
      identifyStatementAccount(readStatementFixture('joint-2026-09.txt'), [
        { id: 'long', numberSuffix: '450001' },
      ]),
    ).toEqual({ ok: true, accountId: 'long' });
  });

  it('R1C / S13: no suffix matches → fail with only the last 4 digits', () => {
    const r = identifyStatementAccount(readStatementFixture('joint-2026-09.txt'), [
      { id: 'joint', numberSuffix: '9999' },
      { id: 'no-suffix', numberSuffix: null },
    ]);
    expect(r).toEqual({
      ok: false,
      message: '找不到尾号是 0001 的 ANZ 账户，先去账户设置填上尾号',
    });
    if (!r.ok) expect(r.message).not.toMatch(/\d{5,}|1234-?5/);
  });

  it('R1C: no accounts at all → same failure', () => {
    expect(identifyStatementAccount(readStatementFixture('joint-2026-09.txt'), []).ok).toBe(false);
  });

  it('R1C / S14: two suffixes match → fail, ask for a longer suffix', () => {
    expect(
      identifyStatementAccount(readStatementFixture('joint-2026-09.txt'), [
        JOINT,
        { id: 'male', numberSuffix: '50001' },
      ]),
    ).toEqual({ ok: false, message: '有 2 个 ANZ 账户的尾号都对得上，去账户设置把尾号填长一点' });
  });

  it('R1C: not a statement → title error; no account number → 找不到账号', () => {
    expect(identifyStatementAccount([{ page: 1, text: 'Dear customer' }], [JOINT])).toEqual({
      ok: false,
      message: '找不到对账单标题，这不像 ANZ 对账单',
    });
    const noNumber = readStatementFixture('joint-2026-09.txt').filter(
      (l) => !/\d{4}-\d{5}/.test(l.text),
    );
    expect(identifyStatementAccount(noNumber, [JOINT])).toEqual({
      ok: false,
      message: '找不到账号',
    });
  });
});
