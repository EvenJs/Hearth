import { beforeAll, describe, expect, it } from 'vitest';
import {
  readAnzPlusStatementFixture,
  readFixture,
  readStatementFixture,
  toStatementLines,
} from '../../../tests/helpers/fixtures';
import { parseAnzPlusStatement } from './anz-plus-statement';
import { parseAnzStatement } from './anz-statement';

// 期望值来自 business-rules.md R1D、R1D.1 和 fixtures/cases/10-anz-plus-statement.md
// fixture 是编的：ANZ Plus Male，number_suffix 0004（fixtures/README.md 账户表）

const SUFFIX = '0004';
const MAIN_TEXT = readFixture('anz-plus-statement/growth-2026-09.txt');

// 在 growth-2026-09.txt 上改一处再解析。from 必须正好出现一次，免得改错地方测试还通过
function parseEdited(from: string, to: string, suffix: string | null = SUFFIX) {
  expect(MAIN_TEXT.split(from)).toHaveLength(2);
  return parseAnzPlusStatement(toStatementLines(MAIN_TEXT.replace(from, to)), suffix);
}

function parseFixture(name: `${string}.txt`, suffix: string | null = SUFFIX) {
  return parseAnzPlusStatement(readAnzPlusStatementFixture(name), suffix);
}

type Result = ReturnType<typeof parseAnzPlusStatement>;
type Success = Extract<Result, { ok: true }>;

function expectFailure(result: Result) {
  if (result.ok) throw new Error('期望解析失败，实际成功了');
  return result;
}

function expectSuccess(result: Result): Success {
  if (!result.ok) throw new Error(`期望解析成功，实际失败了: ${result.message}`);
  return result;
}

// R1D.1 的 4 行，旧的在前
const MAIN_ROWS = [
  {
    date: '2026-09-02',
    amountCents: 100000,
    description: 'TRANSFER FROM 012345-400000002 #100001',
    balanceCents: 1100000,
    rowIndex: 1,
  },
  {
    date: '2026-09-15',
    amountCents: -30000,
    description: 'TRANSFER TO 012345-400000002 #100002',
    balanceCents: 1070000,
    rowIndex: 2,
  },
  {
    date: '2026-09-30',
    amountCents: 500,
    description: 'CREDIT INTEREST PAID',
    balanceCents: 1070500,
    rowIndex: 3,
  },
  {
    date: '2026-09-30',
    amountCents: 2000,
    description: 'BONUS CREDIT INTEREST PAID',
    balanceCents: 1072500,
    rowIndex: 4,
  },
];

describe('parseAnzPlusStatement（R1D）', () => {
  describe('growth-2026-09.txt（A1，R1D.1）', () => {
    let result: Success;
    beforeAll(() => {
      result = expectSuccess(parseFixture('growth-2026-09.txt'));
    });

    it('R1D: parses the 4 rows of R1D.1, oldest first, with balance and rowIndex', () => {
      expect(result.rows).toEqual(MAIN_ROWS);
    });

    it('R1D: reads the period as closed [periodFrom, periodTo], opening, closing and Interest Earned', () => {
      expect(result.periodFrom).toBe('2026-09-01');
      expect(result.periodTo).toBe('2026-09-30');
      expect(result.openingCents).toBe(1000000);
      expect(result.closingCents).toBe(1072500);
      expect(result.interestEarnedCents).toBe(2500);
    });

    it('R1D: Effective Date, address and footer lines are not part of any description', () => {
      const all = result.rows.map((r) => r.description).join('\n');
      expect(all).not.toMatch(/Effective Date|14\/09\/2026/);
      expect(all).not.toMatch(/Example St|Melbourne|AUS|Please check|Footer|Page 1/);
    });

    it('R1D: result does not contain the BSB or the full account number of this account', () => {
      const json = JSON.stringify(result);
      expect(json).not.toMatch(/400 000 004|400000004|012 345/);
    });
  });

  it('R1D: A2 growth-2026-10.txt with no transactions and no Interest Earned is ok, opening equals closing', () => {
    const result = expectSuccess(parseFixture('growth-2026-10.txt'));
    expect(result.rows).toEqual([]);
    expect(result.periodFrom).toBe('2026-10-01');
    expect(result.periodTo).toBe('2026-10-31');
    expect(result.openingCents).toBe(1072500);
    expect(result.closingCents).toBe(1072500);
    expect(result.interestEarnedCents).toBe(0);
  });

  it('R1D: A3 first-day.txt keeps the transaction on periodFrom (closed interval)', () => {
    const result = expectSuccess(parseFixture('first-day.txt'));
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]).toMatchObject({
      date: '2026-09-01',
      amountCents: 1000,
      balanceCents: 1001000,
      rowIndex: 1,
    });
    expect(result.closingCents).toBe(1073500);
  });

  it('R1D: A4 notes-page-2.txt (only notes on page 2) parses like A1', () => {
    const result = expectSuccess(parseFixture('notes-page-2.txt'));
    expect(result.rows).toEqual(MAIN_ROWS);
  });

  it('R1D: A5 multi-page.txt fails because the table spans pages, page is the header page', () => {
    const failure = expectFailure(parseFixture('multi-page.txt'));
    expect(failure.message).toContain('交易表跨页了，还没见过跨页的 ANZ Plus 对账单');
    expect(failure.page).toBe(1);
    expect(failure.index).toBeNull();
  });

  it('R1D: A6 broken-balance.txt fails on the 3rd transaction of page 1', () => {
    const failure = expectFailure(parseFixture('broken-balance.txt'));
    expect(failure.message).toContain('第 3 笔余额接不上');
    expect(failure.page).toBe(1);
    expect(failure.index).toBe(3);
  });

  describe('账号尾号', () => {
    it('R1D: A7 wrong-account.txt fails without the full account number in the message', () => {
      const failure = expectFailure(parseFixture('wrong-account.txt'));
      expect(failure.message).toContain('这份对账单不是这个账户的');
      expect(JSON.stringify(failure)).not.toMatch(/400000002|400 000 002|012 345|\d{5,}/);
      expect(failure.page).toBeNull();
      expect(failure.index).toBeNull();
    });

    it('R1D: A8 account without number_suffix fails and asks to fill it in account settings', () => {
      const failure = expectFailure(parseFixture('growth-2026-09.txt', null));
      expect(failure.message).toContain('账户设置');
    });

    it('R1D: a 6-digit suffix matching the end of the account number (spaces removed) is accepted', () => {
      expectSuccess(parseFixture('growth-2026-09.txt', '000004'));
    });
  });

  describe('检查', () => {
    it('R1D: A9 interest-mismatch.txt fails with the interest total $25.00 and Interest Earned $30.00', () => {
      const failure = expectFailure(parseFixture('interest-mismatch.txt'));
      expect(failure.message).toContain('$25.00');
      expect(failure.message).toContain('$30.00');
      expect(failure.message).toContain('Interest Earned');
      expect(failure.page).toBeNull();
      expect(failure.index).toBeNull();
    });

    it('R1D: A12 without Interest Earned it counts as 0, so interest rows of $25.00 fail', () => {
      const failure = expectFailure(
        parseEdited(
          'Interest Earned  Account Name\n+ $25.00  Male Test',
          'Account Name\nMale Test',
        ),
      );
      expect(failure.message).toContain('$25.00');
      expect(failure.message).toContain('Interest Earned');
      expect(failure.page).toBeNull();
    });

    it('R1D: A14 newest balance differs from Closing Balance', () => {
      const failure = expectFailure(
        parseEdited('$10,000.00  $10,725.00', '$10,000.00  $10,726.00'),
      );
      expect(failure.message).toContain('$10,725.00');
      expect(failure.message).toContain('$10,726.00');
      expect(failure.page).toBeNull();
      expect(failure.index).toBeNull();
    });

    it('R1D: A15 table Opening Balance differs from the summary opening', () => {
      const failure = expectFailure(
        parseEdited('Opening Balance  $10,000.00', 'Opening Balance  $9,999.00'),
      );
      expect(failure.message).toContain('Opening Balance');
      expect(failure.message).toContain('$9,999.00');
      expect(failure.message).toContain('$10,000.00');
      expect(failure.page).toBeNull();
      expect(failure.index).toBeNull();
    });

    it('R1D: no transactions and opening differs from closing fails', () => {
      const text = readFixture('anz-plus-statement/growth-2026-10.txt');
      const from = '$10,725.00  $10,725.00';
      expect(text.split(from)).toHaveLength(2);
      const failure = expectFailure(
        parseAnzPlusStatement(
          toStatementLines(text.replace(from, '$10,725.00  $10,726.00')),
          SUFFIX,
        ),
      );
      expect(failure.page).toBeNull();
    });
  });

  describe('交易行', () => {
    it('R1D: A10 unknown-line.txt fails on an unrecognised line under the 3rd transaction', () => {
      const failure = expectFailure(parseFixture('unknown-line.txt'));
      expect(failure.message).toContain('交易表里第 3 笔下面有一行认不出来');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(3);
    });

    it('R1D: an unrecognised line right under the table header says 表头下面', () => {
      const failure = expectFailure(
        parseEdited(
          'Date  Description  Credit  Debit  Balance\n',
          'Date  Description  Credit  Debit  Balance\nSOMETHING ELSE\n',
        ),
      );
      expect(failure.message).toContain('表头下面有一行认不出来');
    });

    it('R1D: the last two segments must both be amounts', () => {
      const failure = expectFailure(parseEdited('$20.00  $10,725.00', '$20.00  10,725.00'));
      expect(failure.message).toContain('第 1 笔认不出金额和余额');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(1);
    });

    it('R1D: a trailing backslash in the description is kept as is', () => {
      const result = expectSuccess(
        parseEdited(
          '15 Sep  TRANSFER TO 012345-400000002 #100002  ',
          '15 Sep  CARD PURCHASE SHOP\\  ',
        ),
      );
      expect(result.rows[1].description).toBe('CARD PURCHASE SHOP\\');
    });

    it('R1D: A13 a date outside the period fails on the 4th transaction', () => {
      const failure = expectFailure(parseEdited('02 Sep', '02 Oct'));
      expect(failure.message).toContain('第 4 笔的日期不在账期里');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(4);
    });
  });

  describe('账期', () => {
    it('R1D: A11 year-rollover.txt fails because the period crosses a year', () => {
      const failure = expectFailure(parseFixture('year-rollover.txt'));
      expect(failure.message).toContain('账期跨年了，还没见过跨年的 ANZ Plus 对账单');
      expect(failure.page).toBeNull();
      expect(failure.index).toBeNull();
    });

    it('R1D: periodFrom later than periodTo fails', () => {
      const failure = expectFailure(
        parseEdited('1 September 2026 - 30 September 2026', '30 September 2026 - 1 September 2026'),
      );
      expect(failure.message).toContain('账期不对');
    });

    it('R1D: no period line fails', () => {
      const failure = expectFailure(
        parseEdited('1 September 2026 - 30 September 2026  Male Test', 'Male Test'),
      );
      expect(failure.message).toContain('找不到账期');
    });
  });

  describe('认格式', () => {
    it('R1D: A16 first line ANZ ACCOUNT STATEMENT is not an ANZ Plus statement', () => {
      const failure = expectFailure(parseEdited('Account Statement\n', 'ANZ ACCOUNT STATEMENT\n'));
      expect(failure.message).toContain('这不像 ANZ Plus 对账单');
    });

    it('R1D: A16 product line without ANZ Plus is not an ANZ Plus statement (footer ANZ Plus does not count)', () => {
      const failure = expectFailure(parseEdited('ANZ Plus Growth Saver', 'Growth Saver'));
      expect(failure.message).toContain('这不像 ANZ Plus 对账单');
    });

    it('R1D: A17 an R1C ANZ statement fixture is not an ANZ Plus statement', () => {
      const failure = expectFailure(
        parseAnzPlusStatement(readStatementFixture('joint-2026-09.txt'), '0001'),
      );
      expect(failure.message).toContain('这不像 ANZ Plus 对账单');
    });

    it('R1D: A18 parseAnzStatement (R1C) does not accept an ANZ Plus statement', () => {
      const failure = parseAnzStatement(readAnzPlusStatementFixture('growth-2026-09.txt'), SUFFIX);
      expect(failure.ok).toBe(false);
      if (!failure.ok) expect(failure.message).toContain('找不到对账单标题');
    });

    it('R1D: missing table header fails', () => {
      const failure = expectFailure(parseEdited('Date  Description  Credit  Debit  Balance\n', ''));
      expect(failure.message).toContain('找不到交易表');
    });

    it('R1D: missing table Opening Balance fails', () => {
      const failure = expectFailure(parseEdited('Opening Balance  $10,000.00\n', ''));
      expect(failure.message).toContain('找不到交易表的 Opening Balance');
    });

    it('R1D: summary values line not in the 4-segment shape fails', () => {
      const failure = expectFailure(
        parseEdited(
          '012 345  400 000 004  $10,000.00  $10,725.00',
          '012 345  400 000 004  $10,000.00',
        ),
      );
      expect(failure.message).toContain('找不到期初期末');
    });
  });
});
