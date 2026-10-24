import { describe, expect, it } from 'vitest';
import { periodRange } from '@/lib/rules/periods';
import {
  dashboardHref,
  formatPercentChange,
  formatPointsChange,
  formatRange,
  formatSavingsRate,
} from './format';

// 看板的显示格式和 URL（prd.md F6、business-rules.md R10、R10.4；docs/tasks/m5.md M5-3）

const TODAY = '2026-10-24';
const MALE = '22222222-2222-4222-8222-222222222222';

describe('R10.4 comparison text', () => {
  it('percent: sign on every non-zero value, "—" when not comparable', () => {
    expect(formatPercentChange(14)).toBe('+14%');
    expect(formatPercentChange(-13)).toBe('-13%');
    expect(formatPercentChange(0)).toBe('0%');
    expect(formatPercentChange(null)).toBe('—');
  });

  it('savings rate: percentage points', () => {
    expect(formatPointsChange(3)).toBe('+3 pp');
    expect(formatPointsChange(-2)).toBe('-2 pp');
    expect(formatPointsChange(0)).toBe('0 pp');
    expect(formatPointsChange(null)).toBe('—');
  });
});

describe('R10 savings rate', () => {
  it('rounds to a whole percent, "—" when income ≤ 0', () => {
    expect(formatSavingsRate(0.25)).toBe('25%');
    expect(formatSavingsRate(0.218)).toBe('22%');
    expect(formatSavingsRate(-0.125)).toBe('-13%'); // 按绝对值舍入，同 R10.4
    expect(formatSavingsRate(null)).toBe('—');
  });
});

describe('formatRange', () => {
  it('same year as today → no year', () => {
    expect(formatRange({ start: '2026-09-01', end: '2026-09-30' }, TODAY)).toBe('9月1日 – 9月30日');
  });

  it('a single day', () => {
    expect(formatRange({ start: '2026-10-24', end: '2026-10-24' }, TODAY)).toBe('10月24日');
  });

  it('another year → with year', () => {
    expect(formatRange({ start: '2025-07-01', end: '2026-06-30' }, TODAY)).toBe(
      '2025年7月1日 – 2026年6月30日',
    );
  });
});

describe('dashboardHref', () => {
  it('this_month is the default and stays out of the URL', () => {
    expect(dashboardHref({ period: periodRange('this_month', TODAY) })).toBe('/');
  });

  it('other presets and member go in the same params as F8', () => {
    expect(dashboardHref({ period: periodRange('this_fy', TODAY), memberId: MALE })).toBe(
      `/?period=this_fy&member=${MALE}`,
    );
  });

  it('custom → from / to', () => {
    const period = periodRange({ start: '2026-09-01', end: '2026-09-30' }, TODAY);
    expect(dashboardHref({ period })).toBe('/?from=2026-09-01&to=2026-09-30');
  });
});
