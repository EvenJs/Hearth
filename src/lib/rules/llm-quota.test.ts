import { describe, expect, it } from 'vitest';
import { parseMonthlyLimit, quotaLeft, quotaResetDate, quotaText } from './llm-quota';

// 期望值来自 docs/rules/R26-invite.md R26.9
// 和 fixtures/cases/17-invite.md 场景 G（G-2、G-7）

describe('R26.9 限额的环境变量', () => {
  it.each([
    [undefined, 50],
    ['20', 20],
    [' 20 ', 20],
    ['abc', 50],
    ['0', 50],
    ['-5', 50],
    ['12.5', 50],
    ['', 50],
  ])('R26.9: RECEIPT_LLM_MONTHLY_LIMIT %j → %d', (env, limit) => {
    expect(parseMonthlyLimit(env)).toBe(limit);
  });
});

describe('R26.9 判断', () => {
  it.each([
    [49, 50, '2026-12-10', 1, '2027-01-01', '本月还能识别 1 次'],
    [0, 50, '2026-12-10', 50, '2027-01-01', '本月还能识别 50 次'],
    [50, 50, '2026-12-10', 0, '2027-01-01', '本月识别次数用完了，1 月 1 日恢复'],
    [51, 50, '2026-12-10', 0, '2027-01-01', '本月识别次数用完了，1 月 1 日恢复'],
    [50, 50, '2026-11-30', 0, '2026-12-01', '本月识别次数用完了，12 月 1 日恢复'],
    [20, 20, '2026-06-15', 0, '2026-07-01', '本月识别次数用完了，7 月 1 日恢复'],
  ])(
    'R26.9: used %d of %d on %s → left %d, resets %s, shows %s',
    (used, limit, today, left, reset, text) => {
      expect(quotaLeft(used, limit)).toBe(left);
      expect(quotaResetDate(today)).toBe(reset);
      expect(quotaText(used, limit, today)).toBe(text);
    },
  );

  it('R26.9: resets on the 1st of next month from the 1st and month end', () => {
    expect(quotaResetDate('2026-12-01')).toBe('2027-01-01');
    expect(quotaResetDate('2027-01-31')).toBe('2027-02-01');
    expect(quotaResetDate('2028-02-29')).toBe('2028-03-01');
  });
});
