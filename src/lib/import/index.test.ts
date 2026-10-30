import { describe, expect, it } from 'vitest';
import {
  readAnzPlusStatementFixture,
  readFixture,
  readStatementFixture,
} from '../../../tests/helpers/fixtures';
import {
  identifyBankStatement,
  parseBankCsv,
  parseBankStatement,
  statementBank,
  statementPeriod,
} from './index';

// 期望值来自 business-rules.md R1、R1.0-6、R1C、R1D 和 fixtures/README.md（P9）、
// fixtures/cases/08-anz-statement.md（S1、S11）、10-anz-plus-statement.md（B1、B3、B4）

describe('parseBankCsv（R1 按 bank 选解析器）', () => {
  it('R1: anz uses the ANZ parser', () => {
    const result = parseBankCsv('anz', readFixture('anz/joint-2026-09.csv'));
    expect(result.ok && result.rows).toHaveLength(19);
  });

  it('R1: cba uses the CBA parser', () => {
    const result = parseBankCsv('cba', readFixture('cba/female-2026-09.csv'));
    expect(result.ok && result.rows).toHaveLength(20);
  });

  it.each(['anz_plus', 'cash', 'other'] as const)('R1: %s cannot import CSV (P9)', (bank) => {
    const result = parseBankCsv(bank, readFixture('anz/joint-2026-09.csv'));
    expect(result).toEqual({ ok: false, message: '这个账户不能导入 CSV', line: null });
  });

  it('R1.0-6: a bad row fails the whole file with its line number', () => {
    const result = parseBankCsv('anz', readFixture('anz/invalid-date.csv'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.line).toBe(1);
    expect(result.message).toMatch(/第 1 行/);
  });

  it('R1: a file with no rows is an error', () => {
    expect(parseBankCsv('anz', '\r\n')).toEqual({
      ok: false,
      message: '文件里没有交易',
      line: null,
    });
  });
});

// M7.5-5：PDF 对账单按格式选解析器（R1D 认格式：都满足用 R1D，否则交给 R1C）
describe('statementBank（R1C / R1D 认格式）', () => {
  it('R1D: an ANZ Plus statement → anz_plus', () => {
    expect(statementBank(readAnzPlusStatementFixture('growth-2026-09.txt'))).toBe('anz_plus');
  });

  it('R1D: anything else goes to R1C → anz', () => {
    expect(statementBank(readStatementFixture('joint-2026-09.txt'))).toBe('anz');
    expect(statementBank([{ page: 1, text: 'Dear customer' }])).toBe('anz');
  });
});

// fixtures/README.md 的家庭账户（都没归档）
const ACCOUNTS = [
  { id: 'joint', bank: 'anz', numberSuffix: '0001' },
  { id: 'male', bank: 'anz', numberSuffix: '0002' },
  { id: 'female', bank: 'cba', numberSuffix: '0003' },
  { id: 'plus', bank: 'anz_plus', numberSuffix: '0004' },
] as const;

describe('identifyBankStatement（R1C / R1D 自动认账户，ANZ 和 ANZ Plus 不混着找）', () => {
  it('R1C / S11: an ANZ statement → ANZ Joint', () => {
    expect(identifyBankStatement(readStatementFixture('joint-2026-09.txt'), ACCOUNTS)).toEqual({
      ok: true,
      accountId: 'joint',
    });
  });

  it('R1D / B1: an ANZ Plus statement → ANZ Plus Male', () => {
    expect(
      identifyBankStatement(readAnzPlusStatementFixture('growth-2026-09.txt'), ACCOUNTS),
    ).toEqual({ ok: true, accountId: 'plus' });
  });

  it('R1D / B4: wrong-account.txt (…0002) does not pick ANZ Male', () => {
    expect(
      identifyBankStatement(readAnzPlusStatementFixture('wrong-account.txt'), ACCOUNTS),
    ).toEqual({ ok: false, message: '找不到尾号是 0002 的 ANZ Plus 账户，先去账户设置填上尾号' });
  });

  it('R1C: an ANZ statement does not pick an ANZ Plus account with the same suffix', () => {
    expect(
      identifyBankStatement(readStatementFixture('joint-2026-09.txt'), [
        { id: 'plus', bank: 'anz_plus', numberSuffix: '0001' },
      ]),
    ).toEqual({ ok: false, message: '找不到尾号是 0001 的 ANZ 账户，先去账户设置填上尾号' });
  });
});

describe('parseBankStatement（R1C / R1D 按 bank 选解析器）', () => {
  it('R1C / S1: anz → 19 rows, batch date_from is the day after periodFrom', () => {
    const r = parseBankStatement('anz', readStatementFixture('joint-2026-09.txt'), '0001');
    if (!r.ok) throw new Error(r.message);
    expect(r.rows).toHaveLength(19);
    expect(r.rows.every((row) => row.balanceCents === null)).toBe(true);
    expect({ dateFrom: r.dateFrom, dateTo: r.dateTo }).toEqual({
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
    });
  });

  it('R1D / B1: anz_plus → 4 rows with balances, batch date_from = periodFrom', () => {
    const r = parseBankStatement(
      'anz_plus',
      readAnzPlusStatementFixture('growth-2026-09.txt'),
      '0004',
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.rows.map((row) => row.balanceCents)).toEqual([1100000, 1070000, 1070500, 1072500]);
    expect(r).toMatchObject({
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
      openingCents: 1000000,
      closingCents: 1072500,
    });
  });

  it('R1D / B3: anz_plus with 0 transactions still succeeds', () => {
    const r = parseBankStatement(
      'anz_plus',
      readAnzPlusStatementFixture('growth-2026-10.txt'),
      '0004',
    );
    expect(r).toMatchObject({ ok: true, rows: [], dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  });

  it('R1D / A6: failures keep page and index', () => {
    const r = parseBankStatement(
      'anz_plus',
      readAnzPlusStatementFixture('broken-balance.txt'),
      '0004',
    );
    expect(r).toMatchObject({ ok: false, page: 1, index: 3 });
  });

  it('R1: the parser follows the bank, an ANZ Plus statement on an ANZ account fails', () => {
    const r = parseBankStatement('anz', readAnzPlusStatementFixture('growth-2026-09.txt'), '0004');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('找不到对账单标题');
  });

  it.each(['cba', 'cash', 'other'] as const)('R1: %s cannot import a PDF statement', (bank) => {
    expect(
      parseBankStatement(bank, readAnzPlusStatementFixture('growth-2026-09.txt'), '0004'),
    ).toEqual({ ok: false, message: '这个账户不能导入 PDF 对账单', page: null, index: null });
  });
});

// 结果页、历史页显示纸面对账单印的账期
describe('statementPeriod（R1C / R1D 页面显示的账期）', () => {
  it('R1C: anz batch date_from 2026-09-01 → printed period starts 2026-08-31', () => {
    expect(statementPeriod('anz', '2026-09-01', '2026-09-30')).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    });
  });

  it('R1D: anz_plus batch date_from is the printed periodFrom, unchanged', () => {
    expect(statementPeriod('anz_plus', '2026-09-01', '2026-09-30')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });
});
