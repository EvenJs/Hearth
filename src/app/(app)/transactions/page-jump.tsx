'use client';

// 分页中间的"第 [ ] / N 页"（docs/design/README.md 第 3 节，M5.5-5）
// 回车跳转：不是数字不跳，超出范围按 1 或 N；翻页时筛选条件不丢（transactionsHref）
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import type { TransactionFilters } from '@/lib/transactions/filters';
import { parsePageInput } from '@/lib/transactions/pagination';
import { transactionsHref } from './href';

export function PageJump({
  filters,
  page,
  totalPages,
}: {
  filters: TransactionFilters;
  page: number;
  totalPages: number;
}) {
  const router = useRouter();

  function jump(input: HTMLInputElement) {
    const target = parsePageInput(input.value, totalPages);
    // 不跳的时候框里恢复成当前页；跳的时候也先写成实际要去的页（输 9 显示 3）
    input.value = String(target ?? page);
    if (target !== null && target !== page) router.push(transactionsHref(filters, target));
  }

  return (
    <label className="flex items-center gap-1.5 text-muted-foreground">
      第
      <Input
        // 换页后重新挂载，默认值跟着变
        key={page}
        defaultValue={page}
        inputMode="numeric"
        autoComplete="off"
        aria-label={`页码，共 ${totalPages} 页，输入后回车跳转`}
        className="h-8 w-14 px-2 text-center tabular-nums"
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          jump(e.currentTarget);
        }}
        onBlur={(e) => {
          e.currentTarget.value = String(page);
        }}
        onFocus={(e) => e.currentTarget.select()}
      />
      <span className="tabular-nums">/ {totalPages} 页</span>
    </label>
  );
}
