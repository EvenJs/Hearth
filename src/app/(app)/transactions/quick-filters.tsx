import { ArrowLeftRight, CircleDashed } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type { QuickFilter, TransactionFilters } from '@/lib/transactions/filters';
import { cn } from '@/lib/utils';
import type { QuickFilterCounts } from '@/server/transactions';
import { transactionsHref } from './href';

// F8 快捷条件（M4-7）：点一下打开，再点一下关掉；和其他筛选条件可以组合
// 笔数是全部数据的（countQuickFilters），不跟着当前筛选变
// 可能重复（duplicates）不在这里，由列表顶部的提示条打开（M6-6）
const CHIPS: {
  key: Exclude<QuickFilter, 'duplicates'>;
  label: string;
  icon: typeof CircleDashed;
  idle: string;
  active: string;
}[] = [
  {
    key: 'uncategorized',
    label: '未分类',
    icon: CircleDashed,
    idle: 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100',
    active: 'border-amber-500 bg-amber-100 text-amber-900 ring-1 ring-amber-500',
  },
  {
    key: 'suggested',
    label: '建议转账',
    icon: ArrowLeftRight,
    idle: 'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100',
    active: 'border-blue-500 bg-blue-100 text-blue-900 ring-1 ring-blue-500',
  },
];

export function QuickFilters({
  filters,
  counts,
}: {
  filters: TransactionFilters;
  counts: QuickFilterCounts;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">快捷：</span>
      {CHIPS.map(({ key, label, icon: Icon, idle, active }) => {
        const on = filters.quick === key;
        const next: TransactionFilters = { ...filters, quick: on ? undefined : key };
        return (
          <Link
            key={key}
            href={transactionsHref(next)}
            aria-pressed={on}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-full border px-3 transition-colors',
              on ? active : idle,
            )}
          >
            <Icon className="size-3.5" />
            {label}
            <Badge
              variant="secondary"
              className="h-5 min-w-5 rounded-full bg-white/80 px-1.5 tabular-nums"
            >
              {counts[key]}
            </Badge>
          </Link>
        );
      })}
    </div>
  );
}
