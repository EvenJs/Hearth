import { beforeAll, describe, expect, it } from 'vitest';
import {
  readAnzPlusStatementFixture,
  readCbaStatementFixture,
  readFixture,
  readStatementFixture,
  readWestpacStatementFixture,
  toStatementLines,
} from '../../../tests/helpers/fixtures';
import { parseAnzPlusStatement } from './anz-plus-statement';
import { parseAnzStatement } from './anz-statement';
import { parseCbaStatement } from './cba-statement';
import { looksLikeWestpacStatement, parseWestpacStatement } from './westpac-statement';

// 期望值来自 business-rules.md R1G、R1G.1 和 fixtures/cases/18-boq-westpac-statement.md
// fixture 是编的：Westpac Choice Male 尾号 0005，Westpac Life Male 尾号 0006（18 号另加的账户）

const SUFFIX = '0005';
const MAIN_TEXT = readFixture('westpac-statement/choice-2026-11.txt');

// 在 choice-2026-11.txt 上改几处再解析。每个 from 必须正好出现一次，免得改错地方测试还通过
function parseEdited(edits: [from: string, to: string][], suffix: string | null = SUFFIX) {
  return parseWestpacStatement(toStatementLines(edit(edits)), suffix);
}

function edit(edits: [from: string, to: string][]) {
  let text = MAIN_TEXT;
  for (const [from, to] of edits) {
    expect(text.split(from)).toHaveLength(2);
    text = text.replace(from, to);
  }
  return text;
}

function parseFixture(name: `${string}.txt`, suffix: string | null = SUFFIX) {
  return parseWestpacStatement(readWestpacStatementFixture(name), suffix);
}

type Result = ReturnType<typeof parseWestpacStatement>;
type Success = Extract<Result, { ok: true }>;

function expectFailure(result: { ok: boolean; message?: string }) {
  if (result.ok) throw new Error('期望解析失败，实际成功了');
  return result as Extract<Result, { ok: false }>;
}

function expectSuccess(result: Result): Success {
  if (!result.ok) throw new Error(`期望解析成功，实际失败了: ${result.message}`);
  return result;
}

// R1G.1 那张表：5 行，旧的在前，rowIndex 按输出顺序
const MAIN_ROWS = [
  ['2026-11-01', 50000, 'Deposit-Osko Payment 1000001 TEST FRIEND 31 Oct 2026', 150000],
  ['2026-11-03', -30000, 'Withdrawal Mobile 1000002 Tfr Westpac Lif', 120000],
  ['2026-11-03', -30000, 'Withdrawal Mobile 1000003 Tfr Westpac Lif', 90000],
  ['2026-11-10', 275000, 'Deposit-Osko Payment 1000004 ACME PTY LTD 09 Nov 2026', 365000],
  ['2026-11-15', -118645, 'Withdrawal Mobile 1000005 Tfr Westpac Lif', 246355],
].map(([date, amountCents, description, balanceCents], i) => ({
  date,
  amountCents,
  description,
  balanceCents,
  rowIndex: i + 1,
}));

describe('parseWestpacStatement（R1G）', () => {
  describe('choice-2026-11.txt（W1、W2，R1G.1）', () => {
    let result: Success;
    beforeAll(() => {
      result = expectSuccess(parseFixture('choice-2026-11.txt'));
    });

    it('R1G: W1 parses 5 rows oldest first, rowIndex in output order', () => {
      expect(result.rows).toEqual(MAIN_ROWS);
    });

    it('R1G: W1 reads the closed period [periodFrom, periodTo], OPENING and CLOSING BALANCE', () => {
      expect(result.periodFrom).toBe('2026-11-01');
      expect(result.periodTo).toBe('2026-11-30');
      expect(result.openingCents).toBe(100000);
      expect(result.closingCents).toBe(246355);
    });

    it('R1G: W1 name, address, summary, interest table, notes, footers and later pages are not in any description', () => {
      const all = result.rows.map((r) => r.description).join('\n');
      expect(all).not.toMatch(
        /MALE A TEST|TEST STREET|EXAMPLETON|Customer ID|Account|Balance|Total|INTEREST|Rate|%|Statement|Page|ABN|Convenience|Important|Help/,
      );
      expect(all).not.toMatch(/  /); // 续行用一个空格拼
    });

    it('R1G: W2 the first row uses the DATE column (period start, closed interval), not 31 Oct in the description', () => {
      expect(result.rows[0]).toMatchObject({
        date: '2026-11-01',
        amountCents: 50000,
        description: 'Deposit-Osko Payment 1000001 TEST FRIEND 31 Oct 2026',
      });
    });

    it('R1G: W2 the two same-day 03/11 rows come out balance 120000 first, then 90000', () => {
      const sameDay = result.rows.filter((r) => r.date === '2026-11-03');
      expect(sameDay.map((r) => r.balanceCents)).toEqual([120000, 90000]);
    });

    it('R1G: result does not contain the BSB or the full account number', () => {
      const json = JSON.stringify(result);
      expect(json).not.toMatch(/120005|120 005|039-999|039999/);
    });
  });

  it('R1G: W3 life-2026-11.txt parses 3 credits, opening 0', () => {
    const result = expectSuccess(parseFixture('life-2026-11.txt', '0006'));
    expect(result.rows).toEqual([
      {
        date: '2026-11-03',
        amountCents: 30000,
        description: 'Deposit Online 2000001 Tfr Westpac Cho',
        balanceCents: 30000,
        rowIndex: 1,
      },
      {
        date: '2026-11-03',
        amountCents: 30000,
        description: 'Deposit Online 2000002 Tfr Westpac Cho',
        balanceCents: 60000,
        rowIndex: 2,
      },
      {
        date: '2026-11-15',
        amountCents: 118645,
        description: 'Deposit Online 2000003 Tfr Westpac Cho',
        balanceCents: 178645,
        rowIndex: 3,
      },
    ]);
    expect(result.periodFrom).toBe('2026-11-01');
    expect(result.periodTo).toBe('2026-11-30');
    expect(result.openingCents).toBe(0);
    expect(result.closingCents).toBe(178645);
  });

  it('R1G: W4 one-day.txt (one-day period) gives the same 2 rows as rows 2 and 3 of the main file', () => {
    const result = expectSuccess(parseFixture('one-day.txt'));
    const strip = ({ date, amountCents, description, balanceCents }: Success['rows'][number]) => ({
      date,
      amountCents,
      description,
      balanceCents,
    });
    expect(result.rows.map(strip)).toEqual(MAIN_ROWS.slice(1, 3).map(strip));
    expect(result.periodFrom).toBe('2026-11-03');
    expect(result.periodTo).toBe('2026-11-03');
    expect(result.openingCents).toBe(150000);
    expect(result.closingCents).toBe(90000);
  });

  it('R1G: W5 empty-2026-12.txt with no transactions is ok, opening equals closing (opening with + is accepted)', () => {
    const result = expectSuccess(parseFixture('empty-2026-12.txt'));
    expect(result.rows).toEqual([]);
    expect(result.periodFrom).toBe('2026-12-01');
    expect(result.periodTo).toBe('2026-12-31');
    expect(result.openingCents).toBe(246355);
    expect(result.closingCents).toBe(246355);
  });

  it('R1G: three or more amounts at the end of a line → only the last two are amount and balance', () => {
    const result = expectSuccess(
      parseEdited([
        [
          '1000005 Tfr Westpac Lif  1,186.45  2,463.55',
          '1000005 Tfr Westpac Lif 12.50  1,186.45  2,463.55',
        ],
      ]),
    );
    expect(result.rows[4]).toMatchObject({
      amountCents: -118645,
      description: 'Withdrawal Mobile 1000005 Tfr Westpac Lif 12.50',
      balanceCents: 246355,
    });
  });

  describe('检查', () => {
    it('R1G: W6 broken-balance.txt fails on the 4th transaction of page 1', () => {
      const failure = expectFailure(parseFixture('broken-balance.txt'));
      expect(failure.message).toContain('第 4 笔余额接不上');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(4);
    });

    it('R1G: W13 summary-mismatch.txt fails with both debit totals, page is null', () => {
      const failure = expectFailure(parseFixture('summary-mismatch.txt'));
      expect(failure.message).toContain('$1,786.45');
      expect(failure.message).toContain('$1,786.46');
      expect(failure.page).toBeNull();
      expect(failure.index).toBeNull();
    });

    it('R1G: summary credit total differs from the transactions', () => {
      const failure = expectFailure(
        parseEdited([['Total Credits  + $3,250.00', 'Total Credits  + $3,250.01']]),
      );
      expect(failure.message).toContain('$3,250.00');
      expect(failure.message).toContain('$3,250.01');
      expect(failure.page).toBeNull();
    });

    it('R1G: last balance differs from CLOSING BALANCE', () => {
      const failure = expectFailure(
        parseEdited([['30/11/26  CLOSING BALANCE  2,463.55', '30/11/26  CLOSING BALANCE  2,463.56']]),
      );
      expect(failure.message).toContain('$2,463.55');
      expect(failure.message).toContain('$2,463.56');
      expect(failure.page).toBeNull();
    });

    it('R1G: summary opening differs from STATEMENT OPENING BALANCE', () => {
      const failure = expectFailure(
        parseEdited([['Opening Balance  $1,000.00', 'Opening Balance  $1,000.01']]),
      );
      expect(failure.message).toContain('$1,000.00');
      expect(failure.message).toContain('$1,000.01');
      expect(failure.page).toBeNull();
    });

    it('R1G: summary closing differs from CLOSING BALANCE', () => {
      const failure = expectFailure(
        parseEdited([['Closing Balance  + $2,463.55', 'Closing Balance  + $2,463.56']]),
      );
      expect(failure.message).toContain('$2,463.55');
      expect(failure.message).toContain('$2,463.56');
      expect(failure.page).toBeNull();
    });

    it('R1G: W14 without the Total Credits line fails', () => {
      const failure = expectFailure(parseEdited([['Total Credits  + $3,250.00\n', '']]));
      expect(failure.message).toContain('找不到汇总');
    });

    it('R1G: W15 an overdrawn opening (- $x) fails, page is null', () => {
      const failure = expectFailure(
        parseEdited([['Opening Balance  $1,000.00', 'Opening Balance  - $1,000.00']]),
      );
      expect(failure.message).toContain('没见过透支的对账单');
      expect(failure.page).toBeNull();
    });

    it('R1G: an overdrawn closing (- $x) fails too', () => {
      const failure = expectFailure(
        parseEdited([['Closing Balance  + $2,463.55', 'Closing Balance  - $2,463.55']]),
      );
      expect(failure.message).toContain('没见过透支的对账单');
    });
  });

  describe('账号尾号', () => {
    it('R1G: W7 wrong-account.txt fails without the BSB or full account number in the message', () => {
      const failure = expectFailure(parseFixture('wrong-account.txt'));
      expect(failure.message).toContain('这份对账单不是这个账户的');
      for (const leak of ['120002', '120 002', '039-999', '039999']) {
        expect(failure.message).not.toContain(leak);
      }
    });

    it('R1G: W8 account without number_suffix fails and asks to fill it in account settings', () => {
      const failure = expectFailure(parseFixture('choice-2026-11.txt', null));
      expect(failure.message).toContain('账户设置');
      expect(failure.message).toContain('尾号');
    });

    it('R1G: a longer suffix matching the end of the 6-digit account number is accepted', () => {
      expectSuccess(parseFixture('choice-2026-11.txt', '20005'));
    });

    it('R1G: the BSB is not part of the account number, so a suffix reaching into it does not match', () => {
      const failure = expectFailure(parseFixture('choice-2026-11.txt', '9120005'));
      expect(failure.message).toContain('这份对账单不是这个账户的');
    });

    it('R1G: W9 without the account number line fails', () => {
      const failure = expectFailure(parseEdited([['039-999  120 005\n', '']]));
      expect(failure.message).toContain('找不到账号');
    });
  });

  describe('交易', () => {
    it('R1G: W10 unknown-line.txt fails on the line under the 2nd transaction of page 1', () => {
      const failure = expectFailure(parseFixture('unknown-line.txt'));
      expect(failure.message).toContain('交易表里第 2 笔下面有一行认不出来');
      expect(failure.message).not.toContain('EXTRA NOTE');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(2);
    });

    it('R1G: an unknown line right under STATEMENT OPENING BALANCE says OPENING BALANCE 下面', () => {
      const failure = expectFailure(
        parseEdited([
          [
            'OPENING BALANCE  1,000.00\n',
            'OPENING BALANCE  1,000.00\nEXTRA NOTE\n',
          ],
        ]),
      );
      expect(failure.message).toContain('OPENING BALANCE 下面有一行认不出来');
    });

    it('R1G: W11 a new transaction before the previous one has amount and balance fails', () => {
      const failure = expectFailure(parseEdited([['Oct 2026  500.00  1,500.00\n', 'Oct 2026\n']]));
      expect(failure.message).toContain('第 1 笔找不到金额和余额');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(1);
    });

    it('R1G: CLOSING BALANCE before the last transaction has amount and balance fails', () => {
      const failure = expectFailure(
        parseEdited([
          ['1000005 Tfr Westpac Lif  1,186.45  2,463.55', '1000005 Tfr Westpac Lif'],
        ]),
      );
      expect(failure.message).toContain('第 5 笔找不到金额和余额');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(5);
    });

    it('R1G: W12 multi-page.txt fails because the table spans pages, page is the header page, index null', () => {
      const failure = expectFailure(parseFixture('multi-page.txt'));
      expect(failure.message).toContain('交易表跨页了，还没见过跨页的 Westpac 对账单');
      expect(failure.page).toBe(1);
      expect(failure.index).toBeNull();
    });

    it('R1G: W18 a date earlier than the previous transaction fails', () => {
      const failure = expectFailure(parseEdited([['10/11/26  Deposit-Osko', '02/11/26  Deposit-Osko']]));
      expect(failure.message).toContain('第 4 笔的日期比上一笔早');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(4);
    });

    it('R1G: W19 a date outside the period fails', () => {
      const failure = expectFailure(parseEdited([['15/11/26  Withdrawal', '01/12/26  Withdrawal']]));
      expect(failure.message).toContain('第 5 笔的日期不在账期里');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(5);
    });

    it('R1G: W20 an invalid date fails', () => {
      const failure = expectFailure(parseEdited([['15/11/26  Withdrawal', '31/11/26  Withdrawal']]));
      expect(failure.message).toContain('第 5 笔的日期不对');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(5);
    });

    it('R1G: a line between the table header and STATEMENT OPENING BALANCE fails', () => {
      const failure = expectFailure(
        parseEdited([
          [
            'DATE  TRANSACTION DESCRIPTION  DEBIT  CREDIT  BALANCE\n',
            'DATE  TRANSACTION DESCRIPTION  DEBIT  CREDIT  BALANCE\nEXTRA NOTE\n',
          ],
        ]),
      );
      expect(failure.message).toContain('找不到 OPENING BALANCE');
    });

    it('R1G: without CLOSING BALANCE fails', () => {
      const failure = expectFailure(parseEdited([['30/11/26  CLOSING BALANCE  2,463.55\n', '']]));
      expect(failure.message).toContain('找不到 CLOSING BALANCE');
    });
  });

  describe('账期', () => {
    it('R1G: W16 period end differs from the CLOSING BALANCE date', () => {
      const failure = expectFailure(
        parseEdited([['01 November 2026 - 30 November 2026', '01 November 2026 - 29 November 2026']]),
      );
      expect(failure.message).toContain('账期和 OPENING / CLOSING BALANCE 的日期对不上');
      expect(failure.page).toBeNull();
    });

    it('R1G: period start differs from the STATEMENT OPENING BALANCE date', () => {
      const failure = expectFailure(
        parseEdited([['01/11/26  STATEMENT OPENING', '31/10/26  STATEMENT OPENING']]),
      );
      expect(failure.message).toContain('账期和 OPENING / CLOSING BALANCE 的日期对不上');
      expect(failure.page).toBeNull();
    });

    it('R1G: W17 a period of 12 months or more fails', () => {
      const failure = expectFailure(
        parseEdited([
          ['01 November 2026 - 30 November 2026', '01 November 2026 - 30 November 2027'],
          ['30/11/26  CLOSING BALANCE', '30/11/27  CLOSING BALANCE'],
        ]),
      );
      expect(failure.message).toContain('账期超过 12 个月，还没见过这么长的 Westpac 对账单');
      expect(failure.page).toBeNull();
    });

    it('R1G: periodFrom later than periodTo fails', () => {
      const failure = expectFailure(
        parseEdited([['01 November 2026 - 30 November 2026', '01 November 2026 - 30 October 2026']]),
      );
      expect(failure.message).toContain('账期不对');
    });

    it('R1G: line 2 of page 1 is not the period fails', () => {
      const failure = expectFailure(parseEdited([['01 November 2026 - 30 November 2026\n', '']]));
      expect(failure.message).toContain('找不到账期');
    });
  });

  describe('认格式', () => {
    it('R1G: W21 without the Statement Period line it is not a Westpac statement', () => {
      const failure = expectFailure(parseEdited([['Statement Period\n', '']]));
      expect(failure.message).toBe('这不像 Westpac 对账单');
      expect(failure.page).toBeNull();
    });

    it('R1G: W22 R1C, R1D and R1E statement fixtures are not Westpac statements', () => {
      for (const lines of [
        readStatementFixture('joint-2026-09.txt'),
        readAnzPlusStatementFixture('growth-2026-09.txt'),
        readCbaStatementFixture('female-2026-09.txt'),
      ]) {
        const failure = expectFailure(parseWestpacStatement(lines, SUFFIX));
        expect(failure.message).toBe('这不像 Westpac 对账单');
      }
    });

    it('R1G: W23 R1C, R1D and R1E parsers do not accept a Westpac statement', () => {
      const lines = readWestpacStatementFixture('choice-2026-11.txt');
      expect(expectFailure(parseAnzStatement(lines, SUFFIX)).message).toContain('找不到对账单标题');
      expect(expectFailure(parseAnzPlusStatement(lines, SUFFIX)).message).toContain(
        '这不像 ANZ Plus 对账单',
      );
      expect(expectFailure(parseCbaStatement(lines, SUFFIX)).message).toContain(
        '这不像 CBA 对账单',
      );
    });
  });
});

describe('looksLikeWestpacStatement（R1G 认格式）', () => {
  it('R1G: choice, life and empty-2026-12 (0 transactions) are Westpac statements', () => {
    for (const name of ['choice-2026-11.txt', 'life-2026-11.txt', 'empty-2026-12.txt'] as const) {
      expect(looksLikeWestpacStatement(readWestpacStatementFixture(name))).toBe(true);
    }
  });

  it('R1G: R1C, R1D and R1E statements are not', () => {
    expect(looksLikeWestpacStatement(readStatementFixture('joint-2026-09.txt'))).toBe(false);
    expect(looksLikeWestpacStatement(readAnzPlusStatementFixture('growth-2026-09.txt'))).toBe(false);
    expect(looksLikeWestpacStatement(readCbaStatementFixture('female-2026-09.txt'))).toBe(false);
  });

  it('R1G: all three conditions are needed (Statement Period, table header, STATEMENT OPENING BALANCE)', () => {
    for (const edits of [
      [['Statement Period\n', '']],
      [['DATE  TRANSACTION DESCRIPTION  DEBIT  CREDIT  BALANCE\n', '']],
      [['01/11/26  STATEMENT OPENING BALANCE  1,000.00\n', '']],
    ] as [string, string][][]) {
      expect(looksLikeWestpacStatement(toStatementLines(edit(edits)))).toBe(false);
    }
  });

  it('R1G: Statement Period has to be the whole first line of page 1', () => {
    expect(looksLikeWestpacStatement(toStatementLines(`Hello\n${MAIN_TEXT}`))).toBe(false);
  });
});
