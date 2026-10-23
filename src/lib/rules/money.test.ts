import { describe, expect, it } from 'vitest';
import { formatAud, parseAmountToCents } from './money';

// 期望值来自 business-rules.md R1.0-4和 docs/tasks/m2.md M2-2

describe('parseAmountToCents（R1.0-4 金额按字符串转成分）', () => {
  it.each([
    ['-58.40', -5840],
    ['+500.00', 50000],
    ['2000.00', 200000],
    ['0.72', 72],
    ['5', 500],
    ['-0.05', -5],
  ])('R1.0-4: %s → %i', (input, cents) => {
    expect(parseAmountToCents(input)).toBe(cents);
  });

  it('R1.0-4: no float error, "0.29" → 29 (parseFloat("0.29") * 100 = 28.999…)', () => {
    expect(parseAmountToCents('0.29')).toBe(29);
    expect(parseAmountToCents('1.15')).toBe(115);
    expect(parseAmountToCents('4.35')).toBe(435);
  });

  it('R1.0-4: one decimal digit means tens of cents, "5.5" → 550', () => {
    expect(parseAmountToCents('5.5')).toBe(550);
  });

  it('R1.0-4: surrounding whitespace is ignored', () => {
    expect(parseAmountToCents(' -58.40 ')).toBe(-5840);
  });

  it('R1.0-4: thousands separator "1,234.50" is rejected (bank exports never use it)', () => {
    expect(() => parseAmountToCents('1,234.50')).toThrow();
  });

  it.each(['0', '0.00', '-0.00', '+0'])('R1.0-4: zero amount %s is rejected', (input) => {
    expect(() => parseAmountToCents(input)).toThrow();
  });

  it.each([
    '',
    ' ',
    '-',
    '+',
    '.50',
    '5.',
    '1.234',
    '+-1',
    '--1',
    '1e3',
    'abc',
    '$5.00',
    '5.00 CR',
  ])('R1.0-4: malformed amount %j is rejected', (input) => {
    expect(() => parseAmountToCents(input)).toThrow();
  });

  it('R1.0-4: amount beyond Postgres integer range is rejected', () => {
    expect(parseAmountToCents('21474836.47')).toBe(2147483647);
    expect(() => parseAmountToCents('21474836.48')).toThrow();
    expect(() => parseAmountToCents('-21474836.49')).toThrow();
  });
});

describe('formatAud（CLAUDE.md UI：en-AU / AUD）', () => {
  it.each([
    [-5840, '-$58.40'],
    [5, '$0.05'],
    [123450, '$1,234.50'],
    [0, '$0.00'],
  ])('%i → %s', (cents, text) => {
    expect(formatAud(cents)).toBe(text);
  });

  it('rejects non-integer cents', () => {
    expect(() => formatAud(1.5)).toThrow();
  });
});
