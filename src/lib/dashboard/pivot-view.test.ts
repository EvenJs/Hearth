import { describe, expect, it } from 'vitest';
import { periodRange } from '@/lib/rules/periods';
import { dashboardHref } from './format';
import {
  DEFAULT_PIVOT_VIEW,
  pivotColumnLabel,
  pivotSubRows,
  pivotViewFromSearchParams,
} from './pivot-view';

// 看板汇总表的切换和显示（business-rules.md R10.2；docs/tasks/m5.md M5-5）

const TODAY = '2026-10-25';
const MALE = '22222222-2222-4222-8222-222222222222';
const SEPT = periodRange({ start: '2026-09-01', end: '2026-09-30' }, TODAY);

describe('R10.2 pivot view in the URL', () => {
  it('no params → 按周、按分类、支出', () => {
    expect(pivotViewFromSearchParams({})).toEqual({
      granularity: 'week',
      groupBy: 'category',
      metric: 'expense',
    });
    expect(DEFAULT_PIVOT_VIEW).toEqual(pivotViewFromSearchParams({}));
  });

  it('reads grain / group / metric', () => {
    expect(
      pivotViewFromSearchParams({ grain: 'month', group: 'member', metric: 'income' }),
    ).toEqual({ granularity: 'month', groupBy: 'member', metric: 'income' });
    expect(
      pivotViewFromSearchParams(new URLSearchParams('grain=month&group=member&metric=income')),
    ).toEqual({ granularity: 'month', groupBy: 'member', metric: 'income' });
  });

  it('invalid values fall back to the default, one by one', () => {
    expect(
      pivotViewFromSearchParams({ grain: 'year', group: ['member', 'category'], metric: 'x' }),
    ).toEqual({ granularity: 'week', groupBy: 'member', metric: 'expense' });
  });

  it('dashboardHref: default view stays out of the URL', () => {
    expect(dashboardHref({ period: SEPT }, DEFAULT_PIVOT_VIEW)).toBe(
      '/?from=2026-09-01&to=2026-09-30',
    );
  });

  it('dashboardHref: non-default view is kept together with period and member', () => {
    expect(
      dashboardHref(
        { period: SEPT, memberId: MALE },
        { granularity: 'month', groupBy: 'member', metric: 'income' },
      ),
    ).toBe(`/?from=2026-09-01&to=2026-09-30&member=${MALE}&grain=month&group=member&metric=income`);
  });

  it('round trip: what dashboardHref writes, pivotViewFromSearchParams reads back', () => {
    const view = { granularity: 'month', groupBy: 'category', metric: 'income' } as const;
    const qs = dashboardHref({ period: periodRange('this_month', TODAY) }, view).split('?')[1];
    expect(pivotViewFromSearchParams(new URLSearchParams(qs))).toEqual(view);
  });
});

describe('R10.2 column header', () => {
  it('week → M/D–M/D (partial is shown separately)', () => {
    expect(
      pivotColumnLabel({ start: '2026-09-01', end: '2026-09-06', partial: true }, 'week', TODAY),
    ).toBe('9/1–9/6');
    expect(
      pivotColumnLabel({ start: '2026-09-07', end: '2026-09-13', partial: false }, 'week', TODAY),
    ).toBe('9/7–9/13');
  });

  it('week of one day → M/D once', () => {
    expect(
      pivotColumnLabel({ start: '2026-09-30', end: '2026-09-30', partial: true }, 'week', TODAY),
    ).toBe('9/30');
  });

  it('month → 9月; not this year → 2025年11月', () => {
    expect(
      pivotColumnLabel({ start: '2026-09-01', end: '2026-09-30', partial: false }, 'month', TODAY),
    ).toBe('9月');
    expect(
      pivotColumnLabel({ start: '2025-11-01', end: '2025-11-30', partial: false }, 'month', TODAY),
    ).toBe('2025年11月');
  });

  it('partial month still says the month', () => {
    expect(
      pivotColumnLabel({ start: '2026-10-01', end: '2026-10-25', partial: true }, 'month', TODAY),
    ).toBe('10月');
  });
});

// 和 M5-4 支出分类一样：钱直接记在一级上时，展开后多一行"X（不细分）"
describe('R10.2 sub rows with the unsplit part of a top category', () => {
  it('unsplit cells = top cells − sum of children, per column; sorted by total', () => {
    const top = {
      key: 'gro',
      cells: [5840, 3000, 0],
      total: 8840,
      children: [{ key: 'sup', cells: [5840, 1000, 0], total: 6840, children: [] }],
    };
    expect(pivotSubRows(top)).toEqual([
      { key: 'sup', cells: [5840, 1000, 0], total: 6840, children: [], unsplit: false },
      { key: 'gro', cells: [0, 2000, 0], total: 2000, children: [], unsplit: true },
    ]);
  });

  it('no unsplit row when every column adds up', () => {
    const top = {
      key: 'pm',
      cells: [0, -4580],
      total: -4580,
      children: [{ key: 'pmo', cells: [0, -4580], total: -4580, children: [] }],
    };
    expect(pivotSubRows(top)).toEqual([{ ...top.children[0], unsplit: false }]);
  });

  it('unsplit row is kept when its total is 0 but some column is not', () => {
    const top = {
      key: 'gro',
      cells: [500, -500],
      total: 0,
      children: [{ key: 'sup', cells: [0, 0], total: 0, children: [] }],
    };
    expect(pivotSubRows(top).find((r) => r.unsplit)).toEqual({
      key: 'gro',
      cells: [500, -500],
      total: 0,
      children: [],
      unsplit: true,
    });
  });

  it('no children → nothing to expand', () => {
    expect(pivotSubRows({ key: 'bank', cells: [0], total: 0, children: [] })).toEqual([]);
  });
});
