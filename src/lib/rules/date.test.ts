import { describe, expect, it } from 'vitest';
import { parseAuDate } from './date';

// 期望值来自 business-rules.md R1.0-3和 docs/tasks/m2.md M2-2

describe('parseAuDate（R1.0-3 DD/MM/YYYY → YYYY-MM-DD）', () => {
  it.each([
    ['29/09/2026', '2026-09-29'],
    ['02/09/2026', '2026-09-02'],
    ['21/10/2026', '2026-10-21'],
    ['01/01/2026', '2026-01-01'],
    ['31/12/2026', '2026-12-31'],
    ['29/02/2028', '2028-02-29'],
  ])('R1.0-3: %s → %s', (input, out) => {
    expect(parseAuDate(input)).toBe(out);
  });

  it('R1.0-3: surrounding whitespace is ignored', () => {
    expect(parseAuDate(' 29/09/2026 ')).toBe('2026-09-29');
  });

  it.each(['31/02/2026', '29/02/2027', '30/02/2028', '31/04/2026', '00/09/2026', '32/01/2026'])(
    'R1.0-3: impossible day %s is rejected',
    (input) => {
      expect(() => parseAuDate(input)).toThrow();
    },
  );

  it.each(['01/00/2026', '01/13/2026'])('R1.0-3: impossible month %s is rejected', (input) => {
    expect(() => parseAuDate(input)).toThrow();
  });

  it('R1.0-3: century leap years follow the Gregorian rule', () => {
    expect(parseAuDate('29/02/2000')).toBe('2000-02-29');
    expect(() => parseAuDate('29/02/2100')).toThrow();
  });

  it.each([
    '',
    '2026-09-29',
    '9/9/2026',
    '29/9/2026',
    '29/09/26',
    '29-09-2026',
    '29/09/2026 10:00',
  ])('R1.0-3: wrong format %j is rejected', (input) => {
    expect(() => parseAuDate(input)).toThrow();
  });
});
