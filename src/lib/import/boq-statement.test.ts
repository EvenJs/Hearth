import { beforeAll, describe, expect, it } from 'vitest';
import {
  readAnzPlusStatementFixture,
  readBoqStatementFixture,
  readCbaStatementFixture,
  readFixture,
  readStatementFixture,
  readWestpacStatementFixture,
  toStatementLines,
} from '../../../tests/helpers/fixtures';
import { parseAnzPlusStatement } from './anz-plus-statement';
import { parseAnzStatement } from './anz-statement';
import { looksLikeBoqStatement, parseBoqStatement } from './boq-statement';
import { parseCbaStatement } from './cba-statement';
import { parseWestpacStatement } from './westpac-statement';

// 期望值来自 business-rules.md R1F、R1F.1 和 fixtures/cases/18-boq-westpac-statement.md
// fixture 是编的：BOQ Everyday Male 尾号 0007，BOQ Future Saver Male 尾号 0008（18 号另加的账户）

const SUFFIX = '0007';
const MAIN_TEXT = readFixture('boq-statement/everyday-2026-11.txt');

// 在 everyday-2026-11.txt 上改几处再解析。每个 from 必须正好出现一次，免得改错地方测试还通过
function parseEdited(edits: [from: string, to: string][], suffix: string | null = SUFFIX) {
  return parseBoqStatement(toStatementLines(edit(edits)), suffix);
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
  return parseBoqStatement(readBoqStatementFixture(name), suffix);
}

type Result = ReturnType<typeof parseBoqStatement>;
type Success = Extract<Result, { ok: true }>;

function expectFailure(result: { ok: boolean; message?: string }) {
  if (result.ok) throw new Error('期望解析失败，实际成功了');
  return result as Extract<Result, { ok: false }>;
}

function expectSuccess(result: Result): Success {
  if (!result.ok) throw new Error(`期望解析成功，实际失败了: ${result.message}`);
  return result;
}

function strip({ date, amountCents, description, balanceCents }: Success['rows'][number]) {
  return { date, amountCents, description, balanceCents };
}

// 18 号主文件那张表：10 行，旧的在前，rowIndex 按输出顺序
const MAIN_ROWS = (
  [
    ['2026-11-03', 100000, 'From: TEST FRIEND NA', 100000],
    ['2026-11-03', -40000, 'To: Future Saver NOTPROVIDED', 60000],
    ['2026-11-03', -60000, 'To: Future Saver NOTPROVIDED', 0],
    ['2026-11-05', 250000, 'From: ACME PTY LTD Wages NA', 250000],
    ['2026-11-06', -10000, 'To: Future Saver NOTPROVIDED', 240000],
    ['2026-11-06', -10000, 'To: Future Saver NOTPROVIDED', 230000],
    ['2026-11-06', -10000, 'To: Future Saver NOTPROVIDED', 220000],
    ['2026-11-06', -10000, 'To: Future Saver NOTPROVIDED', 210000],
    ['2026-11-06', -10000, 'To: Future Saver NOTPROVIDED', 200000],
    ['2026-11-10', -1250, 'TEST CAFE MELBOURNE Eftpos Purchase - Card 1234', 198750],
  ] as [string, number, string, number][]
).map(([date, amountCents, description, balanceCents], i) => ({
  date,
  amountCents,
  description,
  balanceCents,
  rowIndex: i + 1,
}));

describe('parseBoqStatement（R1F）', () => {
  describe('everyday-2026-11.txt（Q1、Q2，R1F.1）', () => {
    let result: Success;
    beforeAll(() => {
      result = expectSuccess(parseFixture('everyday-2026-11.txt'));
    });

    it('R1F: Q1 parses 10 rows oldest first, rowIndex in output order', () => {
      expect(result.rows).toEqual(MAIN_ROWS);
    });

    it('R1F: Q1 reads the closed period [periodFrom, periodTo], opening and closing from the summary', () => {
      expect(result.periodFrom).toBe('2026-11-01');
      expect(result.periodTo).toBe('2026-11-30');
      expect(result.openingCents).toBe(0);
      expect(result.closingCents).toBe(198750);
    });

    it('R1F: Q1 name, address, summary, year rows, sub-title, headers, footers and later pages are not in any description', () => {
      const all = result.rows.map((r) => r.description).join('\n');
      expect(all).not.toMatch(
        /MALE A TEST|TEST ST\b|EXAMPLETON|Account|Opening|Total|Closing|BSB|Transactions|Processed|Debits|Credits|Balance|Statement|Page|ABN|Important|interest|2026/,
      );
      expect(all).not.toMatch(/  /); // 续行用一个空格拼
    });

    it('R1F: Q2 row 3 has no printed balance, balanceCents is the computed 0', () => {
      expect(result.rows[2]).toMatchObject({ amountCents: -60000, balanceCents: 0 });
    });

    it('R1F: Q2 five same-day same-amount same-description rows keep table order, balances 240000 down to 200000', () => {
      expect(result.rows.slice(4, 9).map((r) => r.balanceCents)).toEqual([
        240000, 230000, 220000, 210000, 200000,
      ]);
    });

    it('R1F: Q2 rows on page 2 (no year row there) are still in 2026', () => {
      expect(result.rows.slice(3).every((r) => r.date.startsWith('2026-'))).toBe(true);
    });

    it('R1F: result does not contain the BSB or the full account number', () => {
      const json = JSON.stringify(result);
      expect(json).not.toMatch(/100000007|129-999|129999/);
    });
  });

  it('R1F: Q3 saver-2026-11.txt (table starts on page 2) parses 7 credits, product name split over two lines is joined', () => {
    const result = expectSuccess(parseFixture('saver-2026-11.txt', '0008'));
    const description = 'From: Everyday Account NOTPROVIDED';
    expect(result.rows).toEqual(
      [
        ['2026-11-03', 40000, 40000],
        ['2026-11-03', 60000, 100000],
        ['2026-11-06', 10000, 110000],
        ['2026-11-06', 10000, 120000],
        ['2026-11-06', 10000, 130000],
        ['2026-11-06', 10000, 140000],
        ['2026-11-06', 10000, 150000],
      ].map(([date, amountCents, balanceCents], i) => ({
        date,
        amountCents,
        description,
        balanceCents,
        rowIndex: i + 1,
      })),
    );
    expect(result.periodFrom).toBe('2026-11-01');
    expect(result.periodTo).toBe('2026-11-30');
    expect(result.openingCents).toBe(0);
    expect(result.closingCents).toBe(150000);
  });

  it('R1F: Q4 a printed 0.00 balance gives exactly the same result as Q1', () => {
    const result = expectSuccess(
      parseEdited([['To: Future Saver  -600.00\n', 'To: Future Saver  -600.00  0.00\n']]),
    );
    expect(result.rows).toEqual(MAIN_ROWS);
    expect(result.closingCents).toBe(198750);
  });

  it('R1F: Q5 a missing balance that does not compute to 0 fails', () => {
    const failure = expectFailure(
      parseEdited([['To: Future Saver  -600.00\n', 'To: Future Saver  -500.00\n']]),
    );
    expect(failure.message).toContain('第 3 笔没有余额，算出来也不是 0');
    expect(failure.page).toBe(1);
    expect(failure.index).toBe(3);
  });

  it('R1F: Q6 on-demand.txt gives the same 9 rows as rows 1 to 9 of the main file', () => {
    const result = expectSuccess(parseFixture('on-demand.txt'));
    expect(result.rows.map(strip)).toEqual(MAIN_ROWS.slice(0, 9).map(strip));
    expect(result.periodFrom).toBe('2026-11-03');
    expect(result.periodTo).toBe('2026-11-06');
    expect(result.openingCents).toBe(0);
    expect(result.closingCents).toBe(200000);
  });

  it('R1F: Q7 cross-year.txt adds a year when the month goes Dec → Jan', () => {
    const result = expectSuccess(parseFixture('cross-year.txt'));
    expect(result.rows).toEqual([
      {
        date: '2026-12-20',
        amountCents: -1250,
        description: 'TEST CAFE MELBOURNE Eftpos Purchase - Card 1234',
        balanceCents: 197500,
        rowIndex: 1,
      },
      {
        date: '2027-01-05',
        amountCents: -10000,
        description: 'To: Future Saver NOTPROVIDED',
        balanceCents: 187500,
        rowIndex: 2,
      },
    ]);
    expect(result.periodFrom).toBe('2026-12-15');
    expect(result.periodTo).toBe('2027-01-14');
  });

  it('R1F: Q8 empty-2026-12.txt with no transactions is ok, opening equals closing', () => {
    const result = expectSuccess(parseFixture('empty-2026-12.txt'));
    expect(result.rows).toEqual([]);
    expect(result.periodFrom).toBe('2026-12-01');
    expect(result.periodTo).toBe('2026-12-31');
    expect(result.openingCents).toBe(198750);
    expect(result.closingCents).toBe(198750);
  });

  it('R1F: the year row may come without the single-letter row above it', () => {
    const result = expectSuccess(parseEdited([['Balance ($)\nA\n2026\n', 'Balance ($)\n2026\n']]));
    expect(result.rows).toEqual(MAIN_ROWS);
  });

  describe('检查', () => {
    it('R1F: Q9 broken-balance.txt fails on the 3rd transaction of page 2', () => {
      const failure = expectFailure(parseFixture('broken-balance.txt'));
      expect(failure.message).toContain('第 3 笔余额接不上');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(3);
    });

    it('R1F: Q10 direction comes from the printed sign, a credit that should be a debit fails the balance check', () => {
      const failure = expectFailure(parseEdited([['-400.00  600.00', '400.00  600.00']]));
      expect(failure.message).toContain('第 2 笔余额接不上');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(2);
    });

    it('R1F: Q14 summary-mismatch.txt fails with both debit totals, page is null', () => {
      const failure = expectFailure(parseFixture('summary-mismatch.txt'));
      expect(failure.message).toContain('$1,512.50');
      expect(failure.message).toContain('$1,512.51');
      expect(failure.page).toBeNull();
      expect(failure.index).toBeNull();
    });

    it('R1F: summary credit total differs from the transactions', () => {
      const failure = expectFailure(
        parseEdited([['Total credits  $3,500.00', 'Total credits  $3,500.01']]),
      );
      expect(failure.message).toContain('$3,500.00');
      expect(failure.message).toContain('$3,500.01');
      expect(failure.page).toBeNull();
    });

    it('R1F: last balance differs from the summary closing balance', () => {
      const failure = expectFailure(
        parseEdited([['Closing balance  $1,987.50', 'Closing balance  $1,987.51']]),
      );
      expect(failure.message).toContain('$1,987.50');
      expect(failure.message).toContain('$1,987.51');
      expect(failure.page).toBeNull();
    });

    it('R1F: Total debits printed as $x without the space is accepted too', () => {
      const result = expectSuccess(
        parseEdited([['Total debits  $ 1,512.50', 'Total debits  $1,512.50']]),
      );
      expect(result.rows).toEqual(MAIN_ROWS);
    });

    it('R1F: Q15 without the Total credits line fails', () => {
      const failure = expectFailure(parseEdited([['Total credits  $3,500.00\n', '']]));
      expect(failure.message).toContain('找不到汇总');
    });

    it('R1F: Q16 an overdrawn closing balance in the summary fails, page is null', () => {
      const failure = expectFailure(
        parseEdited([['Closing balance  $1,987.50', 'Closing balance  -$1,987.50']]),
      );
      expect(failure.message).toContain('没见过透支的对账单');
      expect(failure.page).toBeNull();
    });

    it('R1F: an overdrawn opening balance in the summary fails too', () => {
      const failure = expectFailure(
        parseEdited([['Opening balance  $0.00', 'Opening balance  -$0.00']]),
      );
      expect(failure.message).toContain('没见过透支的对账单');
      expect(failure.page).toBeNull();
    });

    it('R1F: Q17 an overdrawn transaction balance fails on that transaction', () => {
      const failure = expectFailure(parseEdited([['-12.50  1,987.50', '-12.50  -1,987.50']]));
      expect(failure.message).toContain('没见过透支的对账单');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(7);
    });
  });

  describe('账号尾号', () => {
    it('R1F: Q11 wrong-account.txt fails without the BSB or full account number in the message', () => {
      const failure = expectFailure(parseFixture('wrong-account.txt'));
      expect(failure.message).toContain('这份对账单不是这个账户的');
      for (const leak of ['100000002', '129-999', '129999']) {
        expect(failure.message).not.toContain(leak);
      }
    });

    it('R1F: Q12 account without number_suffix fails and asks to fill it in account settings', () => {
      const failure = expectFailure(parseFixture('everyday-2026-11.txt', null));
      expect(failure.message).toContain('账户设置');
      expect(failure.message).toContain('尾号');
    });

    it('R1F: a longer suffix matching the end of the 9-digit account number is accepted', () => {
      expectSuccess(parseFixture('everyday-2026-11.txt', '00000007'));
    });

    it('R1F: the BSB is not part of the account number, so a suffix reaching into it does not match', () => {
      const failure = expectFailure(parseFixture('everyday-2026-11.txt', '9100000007'));
      expect(failure.message).toContain('这份对账单不是这个账户的');
    });

    it('R1F: Q13 without the Account number line fails', () => {
      const failure = expectFailure(parseEdited([['Account number  100000007\n', '']]));
      expect(failure.message).toContain('找不到账号');
    });

    it('R1F: an account number that is not 9 digits fails', () => {
      const failure = expectFailure(
        parseEdited([['Account number  100000007', 'Account number  10000007']]),
      );
      expect(failure.message).toContain('找不到账号');
      expect(failure.message).not.toContain('10000007');
    });
  });

  describe('交易', () => {
    it('R1F: Q18 Date and Processed differ fails', () => {
      const failure = expectFailure(parseEdited([['10-Nov  10-Nov', '10-Nov  11-Nov']]));
      expect(failure.message).toContain('第 7 笔的 Date 和 Processed 不一样，还没见过');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(7);
    });

    it('R1F: Q19 a date earlier than the previous transaction fails', () => {
      const failure = expectFailure(parseEdited([['05-Nov  05-Nov', '02-Nov  02-Nov']]));
      expect(failure.message).toContain('第 1 笔的日期比上一笔早');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(1);
    });

    it('R1F: Q20 a date outside the period fails', () => {
      const failure = expectFailure(parseEdited([['10-Nov  10-Nov', '01-Dec  01-Dec']]));
      expect(failure.message).toContain('第 7 笔的日期不在账期里');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(7);
    });

    it('R1F: Q21 an invalid date fails', () => {
      const failure = expectFailure(parseEdited([['10-Nov  10-Nov', '31-Nov  31-Nov']]));
      expect(failure.message).toContain('第 7 笔的日期不对');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(7);
    });

    it('R1F: Q22 without the year row fails', () => {
      const failure = expectFailure(parseEdited([['\nA\n2026\n', '\nA\n']]));
      expect(failure.message).toContain('找不到年份');
      expect(failure.page).toBe(1);
      expect(failure.index).toBeNull();
    });

    it('R1F: Q23 a year row different from the periodFrom year fails', () => {
      const failure = expectFailure(parseEdited([['\nA\n2026\n', '\nA\n2025\n']]));
      expect(failure.message).toContain('年份行和账期对不上');
      expect(failure.page).toBeNull();
    });

    it('R1F: Q24 a transaction continuing onto the next page fails on the last transaction of the previous page', () => {
      const failure = expectFailure(
        parseEdited([
          ['-600.00\nNOTPROVIDED\n', '-600.00\n'],
          ['Balance ($)\n05-Nov', 'Balance ($)\nNOTPROVIDED\n05-Nov'],
        ]),
      );
      expect(failure.message).toContain('第 3 笔跨页了，还没见过跨页的交易');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(3);
    });

    it('R1F: Q25 a description over 3 lines fails', () => {
      const failure = expectFailure(parseEdited([['Wages\nNA\n', 'Wages\nNA\nEXTRA NOTE\n']]));
      expect(failure.message).toContain('第 1 笔的描述超过 3 行，还没见过');
      expect(failure.message).not.toContain('EXTRA NOTE');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(1);
    });

    it('R1F: Q26 a continuation line ending in an amount fails', () => {
      const failure = expectFailure(
        parseEdited([
          ['-400.00  600.00\nNOTPROVIDED\n', '-400.00  600.00\nNOTPROVIDED\nNOTE  5.00\n'],
        ]),
      );
      expect(failure.message).toContain('第 2 笔下面有一行像金额，认不出来');
      expect(failure.page).toBe(1);
      expect(failure.index).toBe(2);
    });

    it('R1F: Q27 a continuation line that looks like a year row fails', () => {
      const failure = expectFailure(parseEdited([['Card 1234', '2027']]));
      expect(failure.message).toContain('第 7 笔下面有一行像年份行，还没见过跨年时的样子');
      expect(failure.page).toBe(2);
      expect(failure.index).toBe(7);
    });

    it('R1F: a continuation line that is a single letter fails as a year-row look-alike', () => {
      const failure = expectFailure(parseEdited([['Card 1234', 'B']]));
      expect(failure.message).toContain('第 7 笔下面有一行像年份行');
    });

    it('R1F: an unknown line between the year row and the first transaction fails', () => {
      const failure = expectFailure(parseEdited([['\n2026\n', '\n2026\nEXTRA NOTE\n']]));
      expect(failure.message).toContain('交易表里第一笔上面有一行认不出来');
      expect(failure.message).not.toContain('EXTRA NOTE');
    });

    it('R1F: a description with 8 or more consecutive digits is left to R2.3, the parser keeps it as is', () => {
      const result = expectSuccess(parseEdited([['Wages\n', 'REF 12345678\n']]));
      expect(result.rows[3].description).toBe('From: ACME PTY LTD REF 12345678 NA');
    });
  });

  describe('账期', () => {
    it('R1F: line 3 of page 1 is not the period fails', () => {
      const failure = expectFailure(parseEdited([['01 Nov 2026 - 30 Nov 2026\n', '']]));
      expect(failure.message).toContain('找不到账期');
      expect(failure.page).toBeNull();
    });

    it('R1F: periodFrom later than periodTo fails', () => {
      const failure = expectFailure(
        parseEdited([['01 Nov 2026 - 30 Nov 2026', '01 Nov 2026 - 30 Oct 2026']]),
      );
      expect(failure.message).toContain('账期不对');
    });

    it('R1F: a period of 12 months or more fails', () => {
      const failure = expectFailure(
        parseEdited([['01 Nov 2026 - 30 Nov 2026', '01 Nov 2026 - 01 Nov 2027']]),
      );
      expect(failure.message).toContain('账期超过 12 个月，还没见过这么长的 BOQ 对账单');
      expect(failure.page).toBeNull();
    });

    it('R1F: a one-day period is valid', () => {
      const result = expectSuccess(
        parseEdited([
          ['01 Nov 2026 - 30 Nov 2026', '03 Nov 2026 - 03 Nov 2026'],
          ['Total credits  $3,500.00', 'Total credits  $1,000.00'],
          ['Total debits  $ 1,512.50', 'Total debits  $ 1,000.00'],
          ['Closing balance  $1,987.50', 'Closing balance  $0.00'],
          [MAIN_TEXT.slice(MAIN_TEXT.indexOf('05-Nov'), MAIN_TEXT.indexOf('Card 1234\n') + 10), ''],
        ]),
      );
      expect(result.rows.map(strip)).toEqual(MAIN_ROWS.slice(0, 3).map(strip));
      expect(result.periodFrom).toBe('2026-11-03');
      expect(result.periodTo).toBe('2026-11-03');
    });
  });

  describe('认格式', () => {
    it('R1F: Q28 without the Account summary line it is not a BOQ statement', () => {
      const failure = expectFailure(parseEdited([['Account summary\n', '']]));
      expect(failure.message).toBe('这不像 BOQ 对账单');
      expect(failure.page).toBeNull();
    });

    it('R1F: Q29 R1C, R1D, R1E and R1G statement fixtures are not BOQ statements', () => {
      for (const lines of [
        readStatementFixture('joint-2026-09.txt'),
        readAnzPlusStatementFixture('growth-2026-09.txt'),
        readCbaStatementFixture('female-2026-09.txt'),
        readWestpacStatementFixture('choice-2026-11.txt'),
      ]) {
        const failure = expectFailure(parseBoqStatement(lines, SUFFIX));
        expect(failure.message).toBe('这不像 BOQ 对账单');
      }
    });

    it('R1F: Q30 R1C, R1D, R1E and R1G parsers do not accept a BOQ statement', () => {
      for (const name of ['everyday-2026-11.txt', 'saver-2026-11.txt'] as const) {
        const lines = readBoqStatementFixture(name);
        expect(expectFailure(parseAnzStatement(lines, SUFFIX)).message).toContain(
          '找不到对账单标题，这不像 ANZ 对账单',
        );
        expect(expectFailure(parseAnzPlusStatement(lines, SUFFIX)).message).toContain(
          '这不像 ANZ Plus 对账单',
        );
        expect(expectFailure(parseCbaStatement(lines, SUFFIX)).message).toContain(
          '这不像 CBA 对账单',
        );
        expect(expectFailure(parseWestpacStatement(lines, SUFFIX)).message).toContain(
          '这不像 Westpac 对账单',
        );
      }
    });
  });
});

describe('looksLikeBoqStatement（R1F 认格式）', () => {
  it('R1F: everyday, saver and empty-2026-12 (0 transactions) are BOQ statements', () => {
    for (const name of [
      'everyday-2026-11.txt',
      'saver-2026-11.txt',
      'empty-2026-12.txt',
    ] as const) {
      expect(looksLikeBoqStatement(readBoqStatementFixture(name))).toBe(true);
    }
  });

  it('R1F: R1C, R1D, R1E and R1G statements are not', () => {
    expect(looksLikeBoqStatement(readStatementFixture('joint-2026-09.txt'))).toBe(false);
    expect(looksLikeBoqStatement(readAnzPlusStatementFixture('growth-2026-09.txt'))).toBe(false);
    expect(looksLikeBoqStatement(readCbaStatementFixture('female-2026-09.txt'))).toBe(false);
    expect(looksLikeBoqStatement(readWestpacStatementFixture('choice-2026-11.txt'))).toBe(false);
  });

  it('R1F: all three conditions are needed (Statement period, Account summary, table header)', () => {
    const header = 'Date  Processed  Description  Debits ($)  Credits ($)  Balance ($)\n';
    for (const edits of [
      [['Statement period\n', '']],
      [['Account summary\n', '']],
      // 第 1、2 页各有一个表头，两个都删
      [
        [`${header}A\n`, 'A\n'],
        [`${header}05-Nov`, '05-Nov'],
      ],
    ] as [string, string][][]) {
      expect(looksLikeBoqStatement(toStatementLines(edit(edits)))).toBe(false);
    }
  });

  it('R1F: Statement period has to be the whole second line of page 1, lower-case p', () => {
    expect(looksLikeBoqStatement(toStatementLines(`Hello\n${MAIN_TEXT}`))).toBe(false);
    expect(
      looksLikeBoqStatement(toStatementLines(edit([['Statement period\n', 'Statement Period\n']]))),
    ).toBe(false);
  });

  it('R1F: Account summary has to come before the table header', () => {
    const text = edit([
      ['Account summary\n', ''],
      ['Card 1234\n', 'Card 1234\nAccount summary\n'],
    ]);
    expect(looksLikeBoqStatement(toStatementLines(text))).toBe(false);
  });
});
