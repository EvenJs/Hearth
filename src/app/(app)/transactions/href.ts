// 流水页的链接：筛选条件 → /transactions?...，翻页、筛选栏、快捷条件共用
import { filtersToSearchParams, type TransactionFilters } from '@/lib/transactions/filters';

export function transactionsHref(filters: TransactionFilters, page = 1): string {
  const p = filtersToSearchParams(filters);
  if (page > 1) p.set('page', String(page));
  const qs = p.toString();
  return qs ? `/transactions?${qs}` : '/transactions';
}

// 详情页链接，带上列表的查询参数（筛选和页码），详情页"返回流水"时带回去（M4-10）
export function transactionDetailHref(id: string, listHref: string): string {
  const qs = listHref.split('?')[1] ?? '';
  return qs ? `/transactions/${id}?back=${encodeURIComponent(qs)}` : `/transactions/${id}`;
}
