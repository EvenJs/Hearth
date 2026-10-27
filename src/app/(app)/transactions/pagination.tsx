import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { TransactionFilters } from '@/lib/transactions/filters';
import { transactionsHref } from './href';
import { PageJump } from './page-jump';

// 翻页时筛选条件不丢。中间的页码框能直接输入跳转（M5.5-5）

export function Pagination({
  filters,
  page,
  totalPages,
}: {
  filters: TransactionFilters;
  page: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="分页" className="flex items-center justify-between gap-2 text-sm">
      <PageLink filters={filters} page={page - 1} disabled={page <= 1}>
        <ChevronLeft className="size-4" />
        上一页
      </PageLink>
      <PageJump filters={filters} page={page} totalPages={totalPages} />
      <PageLink filters={filters} page={page + 1} disabled={page >= totalPages}>
        下一页
        <ChevronRight className="size-4" />
      </PageLink>
    </nav>
  );
}

function PageLink({
  filters,
  page,
  disabled,
  children,
}: {
  filters: TransactionFilters;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={transactionsHref(filters, page)}>{children}</Link>
    </Button>
  );
}
