// 看板上的点击 → F8 流水筛选条件（prd.md F6：数字能点进 F8 看明细）
// 汇总表（R10.2）点了只展开收起，不跳 F8，没有对应的函数（2026-10-25）
// 拿到的 TransactionFilters 交给 filtersToSearchParams / transactionsHref 拼 URL
// 纯函数，不 import 数据库和 Next.js
import type { DateRange, Period, PresetPeriod } from '@/lib/rules/periods';
import type { Metric } from '@/lib/rules/stats';
import type { TransactionFilters } from '@/lib/transactions/filters';

// 看板当前的时间段和归属人筛选（R10.1、R10.6）
export type DashboardScope = { period: Period; memberId?: string };

// 预置时间段原样带过去（和看板同一个 URL 写法），自定义带起止日期
function periodFilter(period: Period): PresetPeriod | DateRange {
  return period.option === 'custom' ? { start: period.start, end: period.end } : period.option;
}

// R10.6：选了归属人时，跳过去也只看这个归属人的拆分
function base(
  scope: DashboardScope,
  period: PresetPeriod | DateRange = periodFilter(scope.period),
): TransactionFilters {
  return scope.memberId ? { period, memberId: scope.memberId } : { period };
}

export type KpiKind = 'income' | 'pre_tax' | 'expense' | 'uncategorized' | 'pending';

// KPI 卡片：收入、支出按 R16.5 类型；"其中税前"再加 is_pre_tax（R10）；未分类用快捷条件；pending 按交易状态
// 储蓄率是比率不是合计，没有对应的 F8 条件，不跳（M5-3，2026-10-24）
export function kpiLink(scope: DashboardScope, kind: KpiKind): TransactionFilters {
  switch (kind) {
    case 'income':
    case 'expense':
      return { ...base(scope), type: kind };
    case 'pre_tax':
      return { ...base(scope), type: 'income', isPreTax: true };
    case 'uncategorized':
      return { ...base(scope), quick: 'uncategorized' };
    case 'pending':
      return { ...base(scope), status: 'pending' };
  }
}

// 分类行（一级或二级）。F8 选一级时包含它所有的二级
export function categoryLink(scope: DashboardScope, categoryId: string): TransactionFilters {
  return { ...base(scope), categoryId };
}

// R10.3 Top 商家：商家关键词（F8 是"包含"匹配），只看支出类型，和 Top 商家的口径一致
export function merchantLink(scope: DashboardScope, merchant: string): TransactionFilters {
  return { ...base(scope), merchant, type: 'expense' };
}

// R10.5 趋势图某个月：用这个月的范围（不跟时间段选择走）；点柱子带上收入或支出，不带 = 全部
export function trendMonthLink(
  scope: Pick<DashboardScope, 'memberId'>,
  month: DateRange,
  metric?: Metric,
): TransactionFilters {
  const f: TransactionFilters = {
    period: { start: month.start, end: month.end },
    ...(scope.memberId ? { memberId: scope.memberId } : {}),
  };
  if (metric) f.type = metric;
  return f;
}
