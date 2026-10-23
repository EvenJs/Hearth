import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../tests/helpers/fixtures';
import { parseBankCsv } from './index';

// 期望值来自 business-rules.md R1、R1.0-6 和 fixtures/README.md（P9）

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
