import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../tests/helpers/fixtures';
import { checkBalanceContinuity, deriveBalances, parseCbaCsv } from './cba';

// 期望值来自 business-rules.md R1.0、R1B、R1B.1、R1B.2 和 fixtures/README.md

// fixtures/README.md "期望结果：导入 cba/female-2026-09.csv" 的日期和金额(分)
const FEMALE_EXPECTED: [date: string, amountCents: number][] = [
  ['2026-09-30', 1234],
  ['2026-09-28', -90000],
  ['2026-09-25', 300000],
  ['2026-09-24', 100000],
  ['2026-09-22', -45560],
  ['2026-09-20', 400],
  ['2026-09-19', 3860],
  ['2026-09-16', -6490],
  ['2026-09-16', -29840],
  ['2026-09-16', 50000],
  ['2026-09-15', -2280],
  ['2026-09-12', -300],
  ['2026-09-12', -300],
  ['2026-09-10', -7500],
  ['2026-09-08', 2250],
  ['2026-09-08', -4500],
  ['2026-09-05', -680],
  ['2026-09-03', -7135],
  ['2026-09-02', -148000],
  ['2026-09-01', 41000],
];

describe('parseCbaCsv（R1B）', () => {
  it('R1B: parses the doc example row, + sign on amount and balance', () => {
    expect(
      parseCbaCsv('21/10/2026,"+500.00","Transfer from xx5678 CommBank app Home","+12345.67"\r\n'),
    ).toEqual([
      {
        date: '2026-10-21',
        amountCents: 50000,
        description: 'Transfer from xx5678 CommBank app Home',
        balanceCents: 1234567,
        rowIndex: 1,
      },
    ]);
  });

  it('R1B: female-2026-09.csv gives 20 rows in file order, every balanceCents set', () => {
    const rows = parseCbaCsv(readFixture('cba/female-2026-09.csv'));
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual(FEMALE_EXPECTED);
    expect(rows.map((r) => r.rowIndex)).toEqual(FEMALE_EXPECTED.map((_, i) => i + 1));
    expect(rows.every((r) => Number.isInteger(r.balanceCents))).toBe(true);
    expect(rows[0].balanceCents).toBe(1156159);
  });

  it('R1.0-5: description inside quotes keeps commas and inner spacing', () => {
    const [row] = parseCbaCsv('01/09/2026,"-1.00","  SHOP,  MELBOURNE  ","+10.00"\n');
    expect(row.description).toBe('SHOP,  MELBOURNE');
  });

  it('R1B: a zero balance is fine, a zero amount is not', () => {
    expect(parseCbaCsv('01/09/2026,"-1.00","A","+0.00"\n')[0].balanceCents).toBe(0);
    expect(() => parseCbaCsv('01/09/2026,"0.00","A","+1.00"\n')).toThrow(/第 1 行/);
  });

  it('R1.0-2: LF line endings and trailing empty lines work too', () => {
    const crlf = readFixture('cba/female-2026-09.csv');
    expect(parseCbaCsv(crlf.replaceAll('\r\n', '\n') + '\n\n')).toEqual(parseCbaCsv(crlf));
  });

  it('R1B: not exactly 4 columns is an error with the line number', () => {
    expect(() => parseCbaCsv('01/09/2026,"-1.00","A"\n')).toThrow(/第 1 行/);
    expect(() => parseCbaCsv('01/09/2026,"-1.00","A","+1.00","x"\n')).toThrow(/第 1 行/);
  });

  it('R1.0-6: a bad date, amount or balance on a later line names that line', () => {
    const ok = '02/09/2026,"-1.00","A","+10.00"\r\n';
    expect(() => parseCbaCsv(ok + '31/02/2026,"-1.00","B","+11.00"\r\n')).toThrow(/第 2 行/);
    expect(() => parseCbaCsv(ok + '01/09/2026,"-1.00","B","abc"\r\n')).toThrow(/第 2 行/);
  });

  it('R1B: empty description is an error with the line number', () => {
    expect(() => parseCbaCsv('01/09/2026,"-1.00","  ","+1.00"\n')).toThrow(/第 1 行/);
  });
});

describe('checkBalanceContinuity（R1B.1）', () => {
  it('R1B.1: female-2026-09.csv has a continuous balance chain, no warnings', () => {
    expect(checkBalanceContinuity(parseCbaCsv(readFixture('cba/female-2026-09.csv')))).toEqual([]);
  });

  it('R1B.1: broken-balance.csv warns between rows 1→2 and 2→3, without failing', () => {
    const rows = parseCbaCsv(readFixture('cba/broken-balance.csv'));
    expect(rows).toHaveLength(3);
    expect(checkBalanceContinuity(rows)).toEqual([
      { line: 1, nextLine: 2, message: '第 1 行和第 2 行之间余额不连续' },
      { line: 2, nextLine: 3, message: '第 2 行和第 3 行之间余额不连续' },
    ]);
  });

  it('R1B.1: a single row has nothing to check', () => {
    expect(checkBalanceContinuity(parseCbaCsv('01/09/2026,"-1.00","A","+1.00"\n'))).toEqual([]);
  });
});

describe('deriveBalances（R1B.2）', () => {
  it('R1B.2: female-2026-09.csv opening 10,000.00 and closing 11,561.59', () => {
    expect(deriveBalances(parseCbaCsv(readFixture('cba/female-2026-09.csv')))).toEqual({
      openingBalanceCents: 1000000,
      closingBalanceCents: 1156159,
    });
  });

  it('R1B.2: broken-balance.csv opening 9,449.25 and closing 11,561.59', () => {
    expect(deriveBalances(parseCbaCsv(readFixture('cba/broken-balance.csv')))).toEqual({
      openingBalanceCents: 944925,
      closingBalanceCents: 1156159,
    });
  });

  it('R1B.2: no rows is an error', () => {
    expect(() => deriveBalances([])).toThrow();
  });
});
