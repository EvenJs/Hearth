import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../tests/helpers/fixtures';
import { parseAnzCsv } from './anz';

// 期望值来自 business-rules.md R1.0、R1A 和 fixtures/README.md

// fixtures/README.md "期望结果：joint-2026-09.csv" 的日期和金额(分)
const JOINT_EXPECTED: [date: string, amountCents: number][] = [
  ['2026-09-30', 500],
  ['2026-09-30', -500],
  ['2026-09-29', -9840],
  ['2026-09-28', -450],
  ['2026-09-28', -450],
  ['2026-09-25', -15000],
  ['2026-09-22', 8000],
  ['2026-09-22', -6120],
  ['2026-09-20', -3875],
  ['2026-09-18', 4580],
  ['2026-09-15', -50000],
  ['2026-09-12', -2500],
  ['2026-09-10', 150],
  ['2026-09-10', -6230],
  ['2026-09-08', -1200],
  ['2026-09-05', -2715],
  ['2026-09-03', 200000],
  ['2026-09-02', 30000],
  ['2026-09-01', -5840],
];

describe('parseAnzCsv（R1A）', () => {
  it('R1A: parses the doc example row', () => {
    expect(
      parseAnzCsv('29/09/2026,"-58.40",VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE\r\n'),
    ).toEqual([
      {
        date: '2026-09-29',
        amountCents: -5840,
        description: 'VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE',
        balanceCents: null,
        rowIndex: 1,
      },
    ]);
  });

  it('R1A: joint-2026-09.csv gives 19 rows in file order, balanceCents null', () => {
    const rows = parseAnzCsv(readFixture('anz/joint-2026-09.csv'));
    expect(rows.map((r) => [r.date, r.amountCents])).toEqual(JOINT_EXPECTED);
    expect(rows.map((r) => r.rowIndex)).toEqual(JOINT_EXPECTED.map((_, i) => i + 1));
    expect(rows.every((r) => r.balanceCents === null)).toBe(true);
  });

  it('R1.0-5: description is trimmed but inner spacing is kept', () => {
    const rows = parseAnzCsv(readFixture('anz/joint-2026-09.csv'));
    expect(rows[2].description).toBe(
      'ANZ INTERNET BANKING BPAY SEENE                         {123456}',
    );
    expect(rows[16].description).toBe(
      'ANZ M-BANKING FUNDS TFER TRANSFER 100001  FROM       400000002',
    );
    expect(parseAnzCsv('01/09/2026,"-1.00",  COLES  \n')[0].description).toBe('COLES');
  });

  it('R1.0-2: joint-2026-09-lf.csv (LF) gives exactly the same result as CRLF', () => {
    expect(parseAnzCsv(readFixture('anz/joint-2026-09-lf.csv'))).toEqual(
      parseAnzCsv(readFixture('anz/joint-2026-09.csv')),
    );
  });

  it('R1.0-2: trailing empty lines are skipped', () => {
    expect(parseAnzCsv(readFixture('anz/joint-2026-09-overlap.csv'))).toHaveLength(9);
    expect(parseAnzCsv(readFixture('anz/me-2026-09.csv'))).toHaveLength(4);
  });

  it('R1.0-2: empty and whitespace-only lines in the middle are skipped, line numbers kept', () => {
    const rows = parseAnzCsv('01/09/2026,"-1.00",A\r\n\r\n   \r\n02/09/2026,"-2.00",B\r\n');
    expect(rows.map((r) => [r.rowIndex, r.description])).toEqual([
      [1, 'A'],
      [4, 'B'],
    ]);
  });

  it('R1A: a comma in the unquoted description is joined back', () => {
    const [row] = parseAnzCsv('01/09/2026,"-1.00",SHOP, MELBOURNE,AU\n');
    expect(row.description).toBe('SHOP, MELBOURNE,AU');
  });

  it('R1.0-6: invalid-date.csv fails as a whole, error names line 1', () => {
    expect(() => parseAnzCsv(readFixture('anz/invalid-date.csv'))).toThrow(/第 1 行/);
  });

  it('R1.0-4: invalid-zero-amount.csv fails as a whole, error names line 1', () => {
    expect(() => parseAnzCsv(readFixture('anz/invalid-zero-amount.csv'))).toThrow(/第 1 行/);
  });

  it('R1.0-6: an error on a later line names that line', () => {
    expect(() => parseAnzCsv('01/09/2026,"-1.00",A\n\n31/02/2026,"-2.00",B\n')).toThrow(/第 3 行/);
  });

  it('R1A: fewer than 3 columns is an error with the line number', () => {
    expect(() => parseAnzCsv('01/09/2026,"-1.00"\n')).toThrow(/第 1 行/);
  });

  it('R1A: empty description is an error with the line number', () => {
    expect(() => parseAnzCsv('01/09/2026,"-1.00",   \n')).toThrow(/第 1 行/);
  });

  it('R1.0-2: a file with only empty lines gives no rows', () => {
    expect(parseAnzCsv('\r\n\r\n')).toEqual([]);
  });
});
