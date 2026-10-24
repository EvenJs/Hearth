// 流水页的链接：筛选条件 → /transactions?...，翻页、筛选栏、快捷条件共用
import { filtersToSearchParams, type TransactionFilters } from '@/lib/transactions/filters';

export function transactionsHref(filters: TransactionFilters, page = 1): string {
  const p = filtersToSearchParams(filters);
  if (page > 1) p.set('page', String(page));
  const qs = p.toString();
  return qs ? `/transactions?${qs}` : '/transactions';
}
