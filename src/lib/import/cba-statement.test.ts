import { beforeAll, describe, expect, it } from 'vitest';
import {
  readAnzPlusStatementFixture,
  readCbaStatementFixture,
  readFixture,
  readStatementFixture,
  toStatementLines,
} from '../../../tests/helpers/fixtures';
import { parseAnzPlusStatement } from './anz-plus-statement';
import { parseAnzStatement } from './anz-statement';
import {
  identifyCbaStatementAccount,
  looksLikeCbaStatement,
  parseCbaStatement,
} from './cba-statement';

// 期望值来自 business-rules.md R1E、R1E.1 和 fixtures/cases/13-cba-statement.md
// fixture 是编的：CBA Female，number_suffix 0003（fixtures/README.md 账户表）

const SUFFIX = '0003';
const MAIN_TEXT = readFixture('cba-statement/female-2026-09.txt');

// 在 female-2026-09.txt 上改几处再解析。每个 from 必须正好出现一次，免得改错地方测试还通过
function parseEdited(edits: [from: string, to: string][], suffix: string | null = SUFFIX) {
  let text = MAIN_TEXT;
  for (const [from, to] of edits) {
    expect(text.split(from)).toHaveLength(2);
    text = text.replace(from, to);
  }
  return parseCbaStatement(toStatementLines(text), suffix);
}

function parseFixture(name: `${string}.txt`, suffix: string | null = SUFFIX) {
  return parseCbaStatement(readCbaStatementFixture(name), suffix);
}

type Result = ReturnType<typeof parseCbaStatement>;
type Success = Extract<Result, { ok: true }>;

function expectFailure(result: { ok: boolean; message?: string }) {
  if (result.ok) throw new Error('期望解析失败，实际成功了');
  return result as Extract<Result, { ok: false }>;
}

function expectSuccess(result: Result): Success {
  if (!result.ok) throw new Error(`期望解析成功，实际失败了: ${result.message}`);
  return result;
}

// 13-cba-statement.md 主文件的解析结果：20 行，新的在前。
// (date, amountCents, balanceCents) 和顺序同 cba/female-2026-09.csv；描述除了 3 笔 BPAY 也同 CSV
const MAIN_ROWS = [
  ['2026-09-30', 1234, 'Credit Interest', 1156159],
  ['2026-09-28', -90000, 'TAX OFFICE PAYMENTS CommBank app BPAY 7 5512345678901234 Sept', 1154925],
  ['2026-09-25', 300000, 'Fast Transfer From ACME TRADING PTY LTD invoice 0925', 1244925],
  ['2026-09-24', 100000, 'Transfer from xx7777 CommBank app Home', 944925],
  ['2026-09-22', -45560, 'DEFT PAYMENTS CommBank app BPAY 9 12345678901234567890 INV No 0012345', 844925],
  ['2026-09-20', 400, 'CBA Yello HLPckg Cshbk', 890485],
  ['2026-09-19', 3860, 'Direct Credit 002221 MCARE BENEFITS 123456789 ABCD', 890085],
  ['2026-09-16', -6490, 'CROWN ASIAN SPENCER Docklands VI AUS Card xx5555 Value Date: 14/09/2026', 886225],
  ['2026-09-16', -29840, 'Direct Debit 000793 BUPA AUSTRALIA 111122223333444000', 892715],
  ['2026-09-16', 50000, 'Fast Transfer From TEST HOLDER to PayID Phone joint', 922555],
  ['2026-09-15', -2280, 'KIS HAIR Melbourne AU AUS Card xx4444 Value Date: 13/09/2026', 872555],
  ['2026-09-12', -300, 'ZLR*Tower Sushi & Gourm Melbourne AU', 874835],
  ['2026-09-12', -300, 'ZLR*Tower Sushi & Gourm Melbourne AU', 875135],
  ['2026-09-10', -7500, 'LIGHTNING BROADBAND Value Date: 11/09/2026', 875435],
  ['2026-09-08', 2250, 'Fast Transfer From OTHER FRIEND to PayID Phone dinner', 882935],
  ['2026-09-08', -4500, 'Transfer To TEST FRIEND PayID Phone from CommBank App Eat Eat', 880685],
  ['2026-09-05', -680, 'SQ *OVERLAY COFFEE Melbourne VI AUS Card xx5555 Value Date: 03/09/2026', 885185],
  ['2026-09-03', -7135, 'seene CommBank app BPAY 9 1000999999', 885865],
  ['2026-09-02', -148000, 'Loan Repayment LN REPAY 123456789', 893000],
  ['2026-09-01', 41000, 'Salary EXAMPLE SCHOOL Wages 01092026', 1041000],
].map(([date, amountCents, description, balanceCents], i) => ({
  date,
  amountCents,
  description,
  balanceCents,
  rowIndex: i + 1,
}));

describe('parseCbaStatement（R1E）', () => {
  describe('female-2026-09.txt（C1、C2，R1E.1）', () => {
    let result: Success;
    beforeAll(() => {
      result = expectSuccess(parseFixture('female-2026-09.txt'));
    });

    it('R1E: C1 parses 20 rows newest first, rowIndex in output order', () => {
      expect(result.rows).toEqual(MAIN_ROWS);
    });

    it('R1E: C1 reads the closed period [periodFrom, periodTo], OPENING and CLOSING BALANCE', () => {
      expect(result.periodFrom).toBe('2026-09-01');
      expect(result.periodTo).toBe('2026-09-30');
      expect(result.openingCents).toBe(1000000);
      expect(result.closingCents).toBe(1156159);
    });

    it('R1E: C1 margin garbage, page headers, page 1 Closing Balance and notes are not in any description', () => {
      const all = result.rows.map((r) => r.description).join('\n');
      expect(all).not.toMatch(/=|\* \*|ab123c4|0123\.45678|g12\.34|\P{ASCII}/u);
      expect(all).not.toMatch(/Statement|Page|Account Number|Closing Balance|Important|Enquiries/);
      expect(all).not.toMatch(/  /); // 续行用一个空格拼
    });

    it('R1E: C1 every Value Date line gets a colon', () => {
      const withValueDate = result.rows.filter((r) => r.description.includes('Value Date'));
      expect(withValueDate).toHaveLength(4);
      for (const r of withValueDate) expect(r.description).toMatch(/Value Date: \d{2}\/\d{2}\/\d{4}$/);
    });

    it('R1E: C2 the oldest row is on periodFrom (closed interval)', () => {
      expect(result.rows.at(-1)).toMatchObject({ date: '2026-09-01', amountCents: 41000 });
    });

    it('R1E: C2 the two same-day Sushi rows come out balance 874835 first, then 875135 (same as CSV)', () => {
      const sushi = result.rows.filter((r) => r.description.startsWith('ZLR*Tower Sushi'));
      expect(sushi.map((r) => r.balanceCents)).toEqual([874835, 875135]);
    });

    it('R1E: result does not contain the BSB or the full account number', () => {
      const json = JSON.stringify(result);
      expect(json).not.toMatch(/10000003|06 9999|069999/);
    });
  });

  it('R1E: C3 female-2026-10.txt with no transactions is ok, opening equals closing', () => {
    const result = expectSuccess(parseFixture('female-2026-10.txt'));
    expect(result.rows).toEqual([]);
    expect(result.periodFrom).toBe('2026-10-01');
    expect(result.periodTo).toBe('2026-10-31');
    expect(result.openingCents).toBe(1156159);
    expect(result.closingCents).toBe(1156159);
  });

  it('R1E: C4 year-rollover.txt puts Jan in the next year', () => {
    const result = expectSuccess(parseFixture('year-rollover.txt'));
    expect(result.rows).toEqual([
      {
        date: '2027-01-05',
        amountCents: -7500,
        description: 'LIGHTNING BROADBAND Value Date: 06/01/2027',
        balanceCents: 1149059,
        rowIndex: 1,
      },
      {
        date: '2026-12-20',
        amountCents: 400,
        description: 'CBA Yello HLPckg Cshbk',
        balanceCents: 1156559,
        rowIndex: 2,
      },
    ]);
    expect(result.periodFrom).toBe('2026-12-16');
    expect(result.periodTo).toBe('2027-01-15');
    expect(result.openingCents).toBe(1156159);
    expect(result.closingCents).toBe(1149059);
  });

  it('R1E: C15 a description starting with 4 digits is not a year', () => {
    const result = expectSuccess(
      parseEdited([['20 Sep CBA Yello HLPckg Cshbk', '20 Sep 1000 CBA Yello HLPckg Cshbk']]),
    );
    expect(result.rows).toHaveLength(20);
    expect(result.rows.find((r) => r.balanceCents === 890485)).toMatchObject({
      date: '2026-09-20',
      description: '1000 CBA Yello HLPckg Cshbk',
    });
  });

  describe('检查', () => {
    it('R1E: C5 broken-balance.txt fails on the 2nd transaction of page 2', () => {
      const failure = expectFailure(parseFixture('broken-balance.txt'));
      expect(failure.message).toContain('第 2 笔余额接不上');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(2);
    });

    it('R1E: C12 summary-mismatch.txt fails with both debit totals, page is null', () => {
      const failure = expectFailure(parseFixture('summary-mismatch.txt'));
      expect(failure.message).toContain('$3,425.85');
      expect(failure.message).toContain('$3,425.86');
      expect(failure.page).toBeNull();
      expect(failure.index).toBeNull();
    });

    it('R1E: summary credit total differs from the transactions', () => {
      const failure = expectFailure(
        parseEdited([['3,425.85  4,987.44', '3,425.85  4,987.45']]),
      );
      expect(failure.message).toContain('$4,987.44');
      expect(failure.message).toContain('$4,987.45');
    });

    it('R1E: last balance differs from CLOSING BALANCE', () => {
      const failure = expectFailure(
        parseEdited([
          ['30 Sep 2026 CLOSING BALANCE  11,561.59 CR', '30 Sep 2026 CLOSING BALANCE  11,561.60 CR'],
        ]),
      );
      expect(failure.message).toContain('$11,561.59');
      expect(failure.message).toContain('$11,561.60');
      expect(failure.page).toBeNull();
    });

    it('R1E: summary opening differs from OPENING BALANCE', () => {
      const failure = expectFailure(
        parseEdited([['10,000.00 CR  3,425.85', '10,000.01 CR  3,425.85']]),
      );
      expect(failure.message).toContain('$10,000.00');
      expect(failure.message).toContain('$10,000.01');
      expect(failure.page).toBeNull();
    });

    it('R1E: C11 overdraft.txt (DR) fails on page 1, index null', () => {
      const failure = expectFailure(parseFixture('overdraft.txt'));
      expect(failure.message).toContain('没见过透支的对账单');
      expect(failure.page).toBe(1);
      expect(failure.index).toBeNull();
    });

    it('R1E: a DR balance on a transaction fails as overdraft too', () => {
      const failure = expectFailure(
        parseEdited([['Wages 01092026  410.00  10,410.00 CR', 'Wages 01092026  410.00  10,410.00 DR']]),
      );
      expect(failure.message).toContain('没见过透支的对账单');
    });

    it('R1E: C18 without the summary lines fails', () => {
      const failure = expectFailure(
        parseEdited([
          ['Opening balance  -  Total debits  Total credits  =  Closing balance\n', ''],
          ['10,000.00 CR  3,425.85  4,987.44  11,561.59 CR\n', ''],
        ]),
      );
      expect(failure.message).toContain('找不到汇总');
    });
  });

  describe('账号尾号', () => {
    it('R1E: C6 wrong-account.txt fails without the BSB or full account number in the message', () => {
      const failure = expectFailure(parseFixture('wrong-account.txt'));
      expect(failure.message).toContain('这份对账单不是这个账户的');
      expect(failure.message).not.toMatch(/10000002|06 9999|069999/);
    });

    it('R1E: C7 account without number_suffix fails and asks to fill it in account settings', () => {
      const failure = expectFailure(parseFixture('female-2026-09.txt', null));
      expect(failure.message).toContain('账户设置');
      expect(failure.message).toContain('尾号');
    });

    it('R1E: a longer suffix matching the end of BSB + account number (spaces removed) is accepted', () => {
      expectSuccess(parseFixture('female-2026-09.txt', '9910000003'));
    });

    it('R1E: no Account Number line before the table header fails', () => {
      const text = MAIN_TEXT.replace('Account Number  06 9999 10000003\n123\n', '123\n');
      const failure = expectFailure(parseCbaStatement(toStatementLines(text), SUFFIX));
      expect(failure.message).toBe('这不像 CBA 对账单');
    });
  });

  describe('交易', () => {
    it('R1E: C8 unknown-line.txt fails on the line under the 8th transaction of page 1', () => {
      const failure = expectFailure(parseFixture('unknown-line.txt'));
      expect(failure.message).toContain('交易表里第 8 笔下面有一行认不出来');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(8);
    });

    it('R1E: an unknown line right under OPENING BALANCE says OPENING BALANCE 下面', () => {
      const failure = expectFailure(
        parseEdited([
          ['10,000.00 CR\n01 Sep Salary', '10,000.00 CR\nMELBOURNE AU\n01 Sep Salary'],
        ]),
      );
      expect(failure.message).toContain('OPENING BALANCE 下面有一行认不出来');
    });

    it('R1E: C9 split-across-pages.txt fails on the 7th transaction of page 1', () => {
      const failure = expectFailure(parseFixture('split-across-pages.txt'));
      expect(failure.message).toContain('第 7 笔跨页了，还没见过跨页的交易');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(7);
    });

    it('R1E: a new transaction before the previous one has amount and balance fails', () => {
      const failure = expectFailure(
        parseEdited([['LN REPAY 123456789  1,480.00  8,930.00 CR\n', 'LN REPAY 123456789\n']]),
      );
      expect(failure.message).toContain('第 2 笔找不到金额和余额');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(2);
    });

    it('R1E: CLOSING BALANCE before the last transaction has amount and balance fails', () => {
      const failure = expectFailure(
        parseEdited([['30 Sep Credit Interest  12.34  11,561.59 CR', '30 Sep Credit Interest']]),
      );
      expect(failure.message).toContain('第 12 笔找不到金额和余额');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(12);
    });

    it('R1E: C10 garbage-unknown.txt fails on the 3rd transaction of page 1', () => {
      const failure = expectFailure(parseFixture('garbage-unknown.txt'));
      expect(failure.message).toContain('第 3 笔里有一行像乱码，认不出来');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(3);
    });

    it('R1E: garbage of an unknown shape outside the table fails', () => {
      const failure = expectFailure(parseEdited([['Please check', '=XÀâ9)Please check']]));
      expect(failure.message).toContain('对账单里有一行像乱码');
      expect(failure.index).toBeNull();
    });

    it('R1E: C16 a date earlier than the previous transaction fails', () => {
      const failure = expectFailure(parseEdited([['03 Sep seene', '01 Sep seene']]));
      expect(failure.message).toContain('第 3 笔的日期比上一笔早');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(3);
    });

    it('R1E: C17 a smaller month rolls the year, so 30 Aug ends up outside the period', () => {
      const failure = expectFailure(
        parseEdited([['30 Sep Credit Interest', '30 Aug Credit Interest']]),
      );
      expect(failure.message).toContain('第 12 笔的日期不在账期里');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(12);
    });
  });

  describe('账期', () => {
    it('R1E: C13 period end differs from the CLOSING BALANCE date', () => {
      const failure = expectFailure(
        parseEdited([['1 Sep 2026 - 30 Sep 2026', '1 Sep 2026 - 29 Sep 2026']]),
      );
      expect(failure.message).toContain('账期和 OPENING / CLOSING BALANCE 的日期对不上');
      expect(failure.page).toBeNull();
    });

    it('R1E: period start differs from the OPENING BALANCE date', () => {
      const failure = expectFailure(
        parseEdited([['01 Sep 2026 OPENING BALANCE', '31 Aug 2026 OPENING BALANCE']]),
      );
      expect(failure.message).toContain('账期和 OPENING / CLOSING BALANCE 的日期对不上');
      expect(failure.page).toBeNull();
    });

    it('R1E: C14 a period of 12 months or more fails', () => {
      const failure = expectFailure(
        parseEdited([
          ['1 Sep 2026 - 30 Sep 2026', '1 Sep 2026 - 30 Sep 2027'],
          ['30 Sep 2026 CLOSING BALANCE', '30 Sep 2027 CLOSING BALANCE'],
        ]),
      );
      expect(failure.message).toContain('账期超过 12 个月，还没见过这么长的 CBA 对账单');
      expect(failure.page).toBeNull();
    });

    it('R1E: periodFrom later than periodTo fails', () => {
      const failure = expectFailure(
        parseEdited([['1 Sep 2026 - 30 Sep 2026', '1 Sep 2026 - 30 Aug 2026']]),
      );
      expect(failure.message).toContain('账期不对');
    });

    it('R1E: no period line fails', () => {
      const failure = expectFailure(
        parseEdited([['Female A Test  Period  1 Sep 2026 - 30 Sep 2026\n', '']]),
      );
      expect(failure.message).toContain('找不到账期');
    });
  });

  describe('认格式', () => {
    it('R1E: C19 without the Your Statement line it is not a CBA statement', () => {
      const failure = expectFailure(parseEdited([['Your Statement\n', '']]));
      expect(failure.message).toBe('这不像 CBA 对账单');
      expect(failure.page).toBeNull();
    });

    it('R1E: without OPENING BALANCE it is not a CBA statement', () => {
      const failure = expectFailure(
        parseEdited([['01 Sep 2026 OPENING BALANCE  10,000.00 CR\n', '']]),
      );
      expect(failure.message).toBe('这不像 CBA 对账单');
    });

    it('R1E: without the table header it is not a CBA statement', () => {
      const text = MAIN_TEXT.replaceAll('Date  Transaction  Debit  Credit  Balance\n', '');
      const failure = expectFailure(parseCbaStatement(toStatementLines(text), SUFFIX));
      expect(failure.message).toBe('这不像 CBA 对账单');
    });

    it('R1E: C20 R1C and R1D statement fixtures are not CBA statements', () => {
      for (const lines of [
        readStatementFixture('joint-2026-09.txt'),
        readAnzPlusStatementFixture('growth-2026-09.txt'),
      ]) {
        const failure = expectFailure(parseCbaStatement(lines, SUFFIX));
        expect(failure.message).toBe('这不像 CBA 对账单');
      }
    });

    it('R1E: C21 parseAnzStatement (R1C) and parseAnzPlusStatement (R1D) do not accept a CBA statement', () => {
      const lines = readCbaStatementFixture('female-2026-09.txt');
      expect(expectFailure(parseAnzStatement(lines, SUFFIX)).message).toContain('找不到对账单标题');
      expect(expectFailure(parseAnzPlusStatement(lines, SUFFIX)).message).toContain(
        '这不像 ANZ Plus 对账单',
      );
    });
  });
});

describe('looksLikeCbaStatement（R1E 认格式）', () => {
  it('R1E: female-2026-09.txt, female-2026-10.txt (0 transactions) and year-rollover.txt are CBA statements', () => {
    for (const name of ['female-2026-09.txt', 'female-2026-10.txt', 'year-rollover.txt'] as const) {
      expect(looksLikeCbaStatement(readCbaStatementFixture(name))).toBe(true);
    }
  });

  it('R1E: R1C and R1D statements are not', () => {
    expect(looksLikeCbaStatement(readStatementFixture('joint-2026-09.txt'))).toBe(false);
    expect(looksLikeCbaStatement(readAnzPlusStatementFixture('growth-2026-09.txt'))).toBe(false);
  });

  it('R1E: all three conditions are needed (Your Statement, Account Number before the header, OPENING BALANCE)', () => {
    for (const [from, to] of [
      ['Your Statement\n', ''],
      ['Account Number  06 9999 10000003\n123\n', '123\n'],
      ['01 Sep 2026 OPENING BALANCE  10,000.00 CR\n', ''],
    ]) {
      expect(MAIN_TEXT.split(from)).toHaveLength(2);
      expect(looksLikeCbaStatement(toStatementLines(MAIN_TEXT.replace(from, to)))).toBe(false);
    }
  });
});

// M8.5-5：调用方只传没归档的 cba 账户（index.ts 的 identifyBankStatement 筛）
describe('identifyCbaStatementAccount（R1E 自动认账户）', () => {
  const female = { id: 'female', numberSuffix: '0003' };

  it('R1E / D1: exactly one CBA account matches the suffix → that account', () => {
    expect(
      identifyCbaStatementAccount(readCbaStatementFixture('female-2026-09.txt'), [
        female,
        { id: 'saver', numberSuffix: '7777' },
        { id: 'no-suffix', numberSuffix: null },
      ]),
    ).toEqual({ ok: true, accountId: 'female' });
  });

  it('R1E / D8, D9: no CBA account matches → fail, only the last 4 digits in the message', () => {
    const r = identifyCbaStatementAccount(readCbaStatementFixture('wrong-account.txt'), [female]);
    expect(r).toEqual({
      ok: false,
      message: '找不到尾号是 0002 的 CBA 账户，先去账户设置填上尾号',
    });
    if (!r.ok) {
      for (const leak of ['10000002', '06 9999', '069999']) expect(r.message).not.toContain(leak);
    }
  });

  it('R1E / D10: two CBA accounts match → fail', () => {
    expect(
      identifyCbaStatementAccount(readCbaStatementFixture('female-2026-09.txt'), [
        female,
        { id: 'female2', numberSuffix: '00003' },
      ]),
    ).toEqual({ ok: false, message: '有 2 个 CBA 账户的尾号都对得上，去账户设置把尾号填长一点' });
  });

  it('R1E: the account number is not 14 digits → 找不到账号', () => {
    const text = MAIN_TEXT.replace(
      'Account Number  06 9999 10000003\n123\n',
      'Account Number  06 9999 1000003\n123\n',
    );
    expect(text).not.toBe(MAIN_TEXT);
    expect(identifyCbaStatementAccount(toStatementLines(text), [female])).toEqual({
      ok: false,
      message: '找不到账号',
    });
  });

  it('R1E: not a CBA statement → 这不像 CBA 对账单', () => {
    expect(
      identifyCbaStatementAccount(readStatementFixture('joint-2026-09.txt'), [female]),
    ).toEqual({ ok: false, message: '这不像 CBA 对账单' });
  });
});
