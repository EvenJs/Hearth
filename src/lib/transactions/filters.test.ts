import { describe, expect, it } from 'vitest';
import {
  filtersFromSearchParams,
  filtersToSearchParams,
  hasSplitFilter,
  pageFromSearchParams,
  type TransactionFilters,
} from './filters';

// 期望值来自 prd.md F8 筛选、business-rules.md R10.1、R16.5
// 和 M4-2 定下来的约定：金额范围按绝对值、单选、没有时间段 = 全部时间、不合法的参数丢掉

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const CATEGORY = '33333333-3333-4333-8333-333333333333';
const BATCH = '44444444-4444-4444-8444-444444444444';

describe('filtersFromSearchParams', () => {
  it('no params → no filters (all time, everything)', () => {
    expect(filtersFromSearchParams({})).toEqual({});
  });

  it('reads every filter', () => {
    expect(
      filtersFromSearchParams({
        period: 'this_year',
        account: ACCOUNT,
        member: MEMBER,
        category: CATEGORY,
        type: 'expense',
        status: 'confirmed',
        pretax: '1',
        q: 'coles',
        min: '50',
        max: '100.5',
        quick: 'uncategorized',
        batch: BATCH,
      }),
    ).toEqual<TransactionFilters>({
      period: 'this_year',
      accountId: ACCOUNT,
      memberId: MEMBER,
      categoryId: CATEGORY,
      type: 'expense',
      status: 'confirmed',
      isPreTax: true,
      merchant: 'coles',
      minCents: 5000,
      maxCents: 10050,
      quick: 'uncategorized',
      batchId: BATCH,
    });
  });

  it('works with URLSearchParams too', () => {
    expect(filtersFromSearchParams(new URLSearchParams('quick=suggested&pretax=0'))).toEqual({
      quick: 'suggested',
      isPreTax: false,
    });
  });

  it('array values (repeated params) use the first one', () => {
    expect(filtersFromSearchParams({ type: ['income', 'expense'] })).toEqual({ type: 'income' });
  });

  it('R10.1 custom period: from + to', () => {
    expect(filtersFromSearchParams({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      period: { start: '2026-09-01', end: '2026-09-30' },
    });
  });

  it('a preset period wins over from / to', () => {
    expect(
      filtersFromSearchParams({ period: 'this_month', from: '2026-09-01', to: '2026-09-30' }),
    ).toEqual({ period: 'this_month' });
  });

  it.each<[string, Record<string, string>]>([
    ['unknown preset', { period: 'last_decade' }],
    ['only from', { from: '2026-09-01' }],
    ['bad date', { from: '2026-02-31', to: '2026-03-01' }],
    ['not YYYY-MM-DD', { from: '1/9/2026', to: '30/9/2026' }],
    ['from after to', { from: '2026-10-01', to: '2026-09-01' }],
  ])('invalid period is dropped: %s', (_, params) => {
    expect(filtersFromSearchParams(params)).toEqual({});
  });

  it.each<[string, Record<string, string>]>([
    ['account not a uuid', { account: 'joint' }],
    ['member not a uuid', { member: '1' }],
    ['category not a uuid', { category: "1' or 1=1" }],
    ['unknown type', { type: 'savings' }],
    ['unknown status', { status: 'deleted' }],
    ['pretax not 0/1', { pretax: 'yes' }],
    ['unknown quick', { quick: 'duplicates' }],
    ['batch not a uuid', { batch: 'last' }],
    ['blank merchant', { q: '   ' }],
  ])('invalid value is dropped, others kept: %s', (_, params) => {
    expect(filtersFromSearchParams({ ...params, status: params.status ?? 'pending' })).toEqual(
      params.status ? {} : { status: 'pending' },
    );
  });

  it('merchant is trimmed', () => {
    expect(filtersFromSearchParams({ q: '  COLES  ' })).toEqual({ merchant: 'COLES' });
  });

  it('amounts are dollars, absolute, up to 2 decimals; $ and commas allowed', () => {
    expect(filtersFromSearchParams({ min: '$1,200.05', max: '0.5' })).toEqual({
      minCents: 120005,
      maxCents: 50,
    });
  });

  it.each(['-50', '+50', '12.345', 'abc', '1e3', ''])('invalid amount %j is dropped', (v) => {
    expect(filtersFromSearchParams({ min: v, max: v })).toEqual({});
  });
});

describe('filtersToSearchParams', () => {
  it('no filters → empty string', () => {
    expect(filtersToSearchParams({}).toString()).toBe('');
  });

  it('batch → batch param（导入结果页跳过来）', () => {
    const p = filtersToSearchParams({ quick: 'uncategorized', batchId: BATCH });
    expect(Object.fromEntries(p)).toEqual({ quick: 'uncategorized', batch: BATCH });
  });

  it('writes every filter, amounts back in dollars', () => {
    const p = filtersToSearchParams({
      period: { start: '2026-09-01', end: '2026-09-30' },
      accountId: ACCOUNT,
      merchant: 'COLES',
      minCents: 5000,
      maxCents: 10050,
      isPreTax: false,
    });
    expect(Object.fromEntries(p)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      account: ACCOUNT,
      q: 'COLES',
      min: '50.00',
      max: '100.50',
      pretax: '0',
    });
  });

  it('round trip: to → from gives the same filters', () => {
    const all: TransactionFilters[] = [
      {},
      { period: 'this_fy', type: 'income', isPreTax: true },
      {
        period: { start: '2026-01-01', end: '2026-12-31' },
        accountId: ACCOUNT,
        memberId: MEMBER,
        categoryId: CATEGORY,
        status: 'pending',
        merchant: 'MELB ASIAN',
        minCents: 1,
        maxCents: 123456,
        quick: 'suggested',
        batchId: BATCH,
      },
    ];
    for (const f of all) {
      expect(filtersFromSearchParams(filtersToSearchParams(f))).toEqual(f);
    }
  });
});

describe('pageFromSearchParams', () => {
  it.each<[Record<string, string>, number]>([
    [{}, 1],
    [{ page: '3' }, 3],
    [{ page: '0' }, 1],
    [{ page: '-2' }, 1],
    [{ page: '2.5' }, 1],
    [{ page: 'x' }, 1],
  ])('%j → page %d', (params, page) => {
    expect(pageFromSearchParams(params)).toBe(page);
  });
});

describe('hasSplitFilter（R16.5 合计口径）', () => {
  it.each<[TransactionFilters, boolean]>([
    [{}, false],
    [{ period: 'this_year', accountId: ACCOUNT, status: 'confirmed', merchant: 'COLES' }, false],
    [{ minCents: 100, maxCents: 200 }, false], // 金额范围按交易，不按拆分
    [{ quick: 'suggested' }, false], // 建议转账是交易上的 transfer_status
    [{ batchId: BATCH }, false], // 导入批次是交易上的 import_batch_id
    [{ categoryId: CATEGORY }, true],
    [{ memberId: MEMBER }, true],
    [{ type: 'expense' }, true],
    [{ isPreTax: false }, true],
    [{ quick: 'uncategorized' }, true], // 未分类看拆分的分类
  ])('R16.5: %j → %s', (filters, expected) => {
    expect(hasSplitFilter(filters)).toBe(expected);
  });
});
