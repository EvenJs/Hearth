import { Copy, X } from 'lucide-react';
import Link from 'next/link';
import type { TransactionFilters } from '@/lib/transactions/filters';
import { cn } from '@/lib/utils';
import { transactionsHref } from './href';
import { DUPLICATE_TONE } from './tx-badges';

// F8 顶部的"可能重复"提示条（R17.6，M6-6）
// N 只算还是 pending 的手动录入，全部数据，不跟着当前筛选变
// 点了打开 quick = duplicates：带标签的都列出来（pending 和银行那笔），方便比对。不加进筛选栏
export function DuplicatesBanner({
  filters,
  pendingCount,
}: {
  filters: TransactionFilters;
  pendingCount: number;
}) {
  const on = filters.quick === 'duplicates';
  if (!on && pendingCount === 0) return null;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-4 py-2.5 text-sm',
        DUPLICATE_TONE,
      )}
    >
      <Copy className="size-4 shrink-0" />
      {on ? (
        <>
          <span className="min-w-0 flex-1">
            正在看可能重复的交易
            {pendingCount > 0 && <>（{pendingCount} 笔待确认的手动录入）</>}
          </span>
          <Link
            href={transactionsHref({ ...filters, quick: undefined })}
            className="flex items-center gap-1 font-medium underline-offset-2 hover:underline"
          >
            <X className="size-3.5" />
            取消
          </Link>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1">
            <strong className="tabular-nums">{pendingCount}</strong>{' '}
            笔可能重复的手动录入：导入时几笔都对上了同一笔银行交易
          </span>
          <Link
            href={transactionsHref({ ...filters, quick: 'duplicates' })}
            className="font-medium underline underline-offset-2"
          >
            查看
          </Link>
        </>
      )}
    </div>
  );
}
