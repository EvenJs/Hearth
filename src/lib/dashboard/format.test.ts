import { describe, expect, it } from 'vitest';
import { periodRange } from '@/lib/rules/periods';
import {
  dashboardHref,
  expenseShare,
  expenseShareBase,
  expenseSubLines,
  formatPercentChange,
  formatPointsChange,
  formatRange,
  formatSavingsRate,
  formatShare,
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

// R10 分类支出：负数照实显示，占比按正数支出合计算，负数行没有占比（docs/tasks/m5.md M5-4）
describe('R10 expense share by category', () => {
  // 一级的合计，按金额从大到小（summarize 的顺序）；Personal & medical 是退款大于支出
  const rows = [{ cents: 30000 }, { cents: 15795 }, { cents: 0 }, { cents: -4580 }];

  it('R10: base is the sum of positive rows only, negative rows are not netted', () => {
    expect(expenseShareBase(rows)).toBe(45795);
  });

  it('R10: share of a positive row is cents / base', () => {
    expect(expenseShare(15795, 45795)).toBeCloseTo(15795 / 45795);
    expect(expenseShare(0, 45795)).toBe(0);
  });

  it('R10: negative row (refund larger than spending) has no share', () => {
    expect(expenseShare(-4580, 45795)).toBeNull();
  });

  it('R10: no positive spending at all → no share', () => {
    expect(expenseShareBase([{ cents: 0 }, { cents: -4580 }])).toBe(0);
    expect(expenseShare(0, 0)).toBeNull();
  });

  it('share text: one decimal, "—" when there is no share', () => {
    expect(formatShare(15795 / 45795)).toBe('34.5%');
    expect(formatShare(0)).toBe('0.0%');
    expect(formatShare(1)).toBe('100.0%');
    expect(formatShare(null)).toBe('—');
  });
});

// 钱直接记在一级上（没细分到二级）时，展开后多一行"X（不细分）"，二级加起来才等于一级（M5-4，2026-10-24）
describe('R10 expense sub lines with the unsplit part of a top category', () => {
  it('top-level part becomes an unsplit line, sorted with the children by amount', () => {
    const top = {
      categoryId: 'gro',
      cents: 20000,
      children: [
        { categoryId: 'sup', cents: 15795 },
        { categoryId: 'mkt', cents: 1000 },
      ],
    };
    expect(expenseSubLines(top)).toEqual([
      { categoryId: 'sup', cents: 15795, unsplit: false },
      { categoryId: 'gro', cents: 3205, unsplit: true },
      { categoryId: 'mkt', cents: 1000, unsplit: false },
    ]);
  });

  it('no unsplit line when the children add up to the top', () => {
    const top = { categoryId: 'pm', cents: -4580, children: [{ categoryId: 'pmo', cents: -4580 }] };
    expect(expenseSubLines(top)).toEqual([{ categoryId: 'pmo', cents: -4580, unsplit: false }]);
  });

  it('unsplit part can be negative (refund on the top itself)', () => {
    const top = {
      categoryId: 'gro',
      cents: 15645,
      children: [{ categoryId: 'sup', cents: 15795 }],
    };
    expect(expenseSubLines(top)).toEqual([
      { categoryId: 'sup', cents: 15795, unsplit: false },
      { categoryId: 'gro', cents: -150, unsplit: true },
    ]);
  });

  it('no children (system category, or all spending on the top) → nothing to expand', () => {
    expect(expenseSubLines({ categoryId: 'bank', cents: 0, children: [] })).toEqual([]);
    expect(expenseSubLines({ categoryId: 'gro', cents: 5000, children: [] })).toEqual([]);
  });
});
