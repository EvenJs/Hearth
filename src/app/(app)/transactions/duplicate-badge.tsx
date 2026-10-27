'use client';

// F8 "可能重复"标签（R16.8、R17.6，M6-6）：玫红色，和未分类（琥珀）、建议转账（蓝）、待确认（灰）分开
// 鼠标放上去（手机上点）展开对方是哪几笔，点了跳到那笔的详情
// 标签是 button，点它不会触发整行跳转（transaction-list.tsx 的 useRowClick）
import { Clock, Copy } from 'lucide-react';
import Link from 'next/link';
import { useLayoutEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatAud } from '@/lib/rules/money';
import { cn } from '@/lib/utils';
import type { DuplicatePartner } from '@/server/transactions';
import { formatTxDate } from './format';
import { transactionDetailHref } from './href';
import { DUPLICATE_TONE } from './tx-badges';

const CLOSE_DELAY_MS = 150; // 鼠标从标签挪到浮层上的空隙

export function DuplicateBadge({
  partners,
  today,
  listHref,
}: {
  partners: DuplicatePartner[];
  today: string;
  listHref: string;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // 浮层是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(
    () => () => {
      clearTimeout(closeTimer.current);
      setOpen(false);
    },
    [],
  );

  if (partners.length === 0) return null;

  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideSoon = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  // 只有真的鼠标才按悬停开关；触屏的点按交给 Popover 自己的 onOpenChange
  const onEnter = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') show();
  };
  const onLeave = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') hideSoon();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
          className={cn(
            'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            DUPLICATE_TONE,
          )}
        >
          <Copy className="size-3" />
          可能重复
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        // 不抢焦点，悬停时页面不会跳
        onOpenAutoFocus={(e) => e.preventDefault()}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          导入时和这几笔对上了同一笔银行交易：
        </p>
        <ul className="flex flex-col py-1">
          {partners.map((p) => (
            <li key={p.id}>
              <Link
                href={transactionDetailHref(p.id, listHref)}
                className="flex flex-col gap-0.5 px-3 py-1.5 text-sm hover:bg-accent"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words">{p.merchant}</span>
                  <span className="shrink-0 tabular-nums">{formatAud(p.amountCents)}</span>
                </span>
                <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>{formatTxDate(p.date, today)}</span>
                  <span>{p.account.name}</span>
                  {p.status === 'pending' && (
                    <span className="inline-flex items-center gap-0.5">
                      <Clock className="size-3" />
                      待确认
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          删掉或改掉多余的手动录入，提示会自动消失
        </p>
      </PopoverContent>
    </Popover>
  );
}
