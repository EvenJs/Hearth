import { describe, expect, it } from 'vitest';
import { checkCsvFile, importFormSchema, MAX_CSV_BYTES, parseBalanceInput } from './import-input';

// 期望值来自 docs/tasks/m3.md M3-7 和 business-rules.md R9（ANZ 期初期末可选，要么都填要么都不填）

const ACCOUNT_ID = '6f1c2a3e-9b4d-4c5e-8f7a-1b2c3d4e5f60';

function errorsOf(input: unknown) {
  const r = importFormSchema.safeParse(input);
  if (r.success) return null;
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

describe('parseBalanceInput', () => {
  it('empty → null', () => {
    expect(parseBalanceInput('')).toBeNull();
    expect(parseBalanceInput('   ')).toBeNull();
  });

  it('dollars → integer cents, as copied from a PDF statement ($ and thousands commas allowed)', () => {
    expect(parseBalanceInput('14195.10')).toBe(1419510);
    expect(parseBalanceInput('$14,195.10')).toBe(1419510);
    expect(parseBalanceInput(' 18,420.5 ')).toBe(1842050);
    expect(parseBalanceInput('0')).toBe(0);
    expect(parseBalanceInput('-12.34')).toBe(-1234);
  });

  it('rejects anything that is not an amount', () => {
    for (const bad of ['abc', '1.234', '12.3.4', '--1', '$', '1e3']) {
      expect(() => parseBalanceInput(bad), bad).toThrow();
    }
  });
});

describe('importFormSchema', () => {
  it('account only (CBA, or ANZ without balances) → both balances null', () => {
    expect(
      importFormSchema.parse({ accountId: ACCOUNT_ID, openingBalance: '', closingBalance: '' }),
    ).toEqual({ accountId: ACCOUNT_ID, openingBalanceCents: null, closingBalanceCents: null });
  });

  it('R9: ANZ with both balances → integer cents', () => {
    expect(
      importFormSchema.parse({
        accountId: ACCOUNT_ID,
        openingBalance: '1,000.00',
        closingBalance: '2385.10',
      }),
    ).toEqual({ accountId: ACCOUNT_ID, openingBalanceCents: 100000, closingBalanceCents: 238510 });
  });

  it('no account selected → error on accountId', () => {
    expect(errorsOf({ accountId: '', openingBalance: '', closingBalance: '' })).toEqual([
      { path: 'accountId', message: '请选择账户' },
    ]);
  });

  it('R9: only one balance filled → error on the empty one', () => {
    expect(errorsOf({ accountId: ACCOUNT_ID, openingBalance: '100', closingBalance: '' })).toEqual([
      { path: 'closingBalance', message: '期初和期末要一起填，或者都不填' },
    ]);
    expect(errorsOf({ accountId: ACCOUNT_ID, openingBalance: '', closingBalance: '100' })).toEqual([
      { path: 'openingBalance', message: '期初和期末要一起填，或者都不填' },
    ]);
  });

  it('bad amount → error on that field', () => {
    expect(
      errorsOf({ accountId: ACCOUNT_ID, openingBalance: 'abc', closingBalance: '100' }),
    ).toEqual([{ path: 'openingBalance', message: '金额格式不对，例如 14,195.10' }]);
  });
});

describe('checkCsvFile', () => {
  it('a normal .csv under 1 MB is fine (extension case-insensitive)', () => {
    expect(checkCsvFile({ name: 'joint-2026-09.csv', size: 1234 })).toBeNull();
    expect(checkCsvFile({ name: 'CommBank.CSV', size: MAX_CSV_BYTES })).toBeNull();
  });

  it('only .csv', () => {
    expect(checkCsvFile({ name: 'statement.pdf', size: 1234 })).toBe('只支持 .csv 文件');
    expect(checkCsvFile({ name: 'csv', size: 1234 })).toBe('只支持 .csv 文件');
  });

  it('max 1 MB, not empty', () => {
    expect(MAX_CSV_BYTES).toBe(1024 * 1024);
    expect(checkCsvFile({ name: 'a.csv', size: MAX_CSV_BYTES + 1 })).toBe('文件不能超过 1 MB');
    expect(checkCsvFile({ name: 'a.csv', size: 0 })).toBe('文件是空的');
  });
});
