import { describe, expect, it } from 'vitest';
import { periodRange } from '@/lib/rules/periods';
import { filtersToSearchParams, type TransactionFilters } from '@/lib/transactions/filters';
import { categoryLink, kpiLink, merchantLink, trendMonthLink, type DashboardScope } from './links';

// 看板点击 → F8 筛选条件（prd.md F6、business-rules.md R10.2、R10.6、R16.5；docs/tasks/m5.md M5-1）

const MALE = '22222222-2222-4222-8222-222222222222';
const CATEGORY = '33333333-3333-4333-8333-333333333333';
const TODAY = '2026-10-24';
const SEPT = periodRange({ start: '2026-09-01', end: '2026-09-30' }, TODAY);
const SEPT_RANGE = { start: '2026-09-01', end: '2026-09-30' };

const all: DashboardScope = { period: SEPT };
const male: DashboardScope = { period: SEPT, memberId: MALE };

describe('kpiLink', () => {
  it('income / expense → type filter with the period', () => {
    expect(kpiLink(all, 'income')).toEqual<TransactionFilters>({
      period: SEPT_RANGE,
      type: 'income',
    });
    expect(kpiLink(all, 'expense')).toEqual<TransactionFilters>({
      period: SEPT_RANGE,
      type: 'expense',
    });
  });

  it('uncategorised → quick filter; pending → status', () => {
    expect(kpiLink(all, 'uncategorized')).toEqual({
      period: SEPT_RANGE,
      quick: 'uncategorized',
    });
    expect(kpiLink(all, 'pending')).toEqual({
      period: SEPT_RANGE,
      status: 'pending',
    });
  });

  it('R10 pre-tax income → income type with isPreTax', () => {
    expect(kpiLink(male, 'pre_tax')).toEqual<TransactionFilters>({
      period: SEPT_RANGE,
      memberId: MALE,
      type: 'income',
      isPreTax: true,
    });
  });

  it('R10.6: the member filter is carried along', () => {
    expect(kpiLink(male, 'expense')).toEqual({
      period: SEPT_RANGE,
      memberId: MALE,
      type: 'expense',
    });
  });

  it('a preset period stays a preset (same URL as the dashboard)', () => {
    const scope = { period: periodRange('this_month', TODAY) };
    expect(kpiLink(scope, 'income').period).toBe('this_month');
    expect(filtersToSearchParams(kpiLink(scope, 'income')).toString()).toBe(
      'period=this_month&type=income',
    );
  });
});

describe('categoryLink / merchantLink', () => {
  it('category row → categoryId (first level includes its children in F8)', () => {
    expect(categoryLink(male, CATEGORY)).toEqual({
      period: SEPT_RANGE,
      memberId: MALE,
      categoryId: CATEGORY,
    });
  });

  it('R10.3: merchant → merchant keyword, expense type only', () => {
    expect(merchantLink(all, 'MELB ASIAN MARKET')).toEqual({
      period: SEPT_RANGE,
      merchant: 'MELB ASIAN MARKET',
      type: 'expense',
    });
  });
});

describe('trendMonthLink（R10.5）', () => {
  it('R10.5: a month → that month range, not the selected period', () => {
    expect(trendMonthLink(male, { start: '2026-10-01', end: '2026-10-24' }, 'expense')).toEqual({
      period: { start: '2026-10-01', end: '2026-10-24' },
      memberId: MALE,
      type: 'expense',
    });
  });

  it('R10.5: without a metric → all types (net)', () => {
    expect(trendMonthLink(all, { start: '2026-09-01', end: '2026-09-30' })).toEqual({
      period: SEPT_RANGE,
    });
  });
});
