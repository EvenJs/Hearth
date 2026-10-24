'use client';

import { ChevronDown, CornerDownRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatAud } from '@/lib/rules/money';
import { cn } from '@/lib/utils';
import type { SplitView, TransactionListItem } from '@/server/transactions';
import { formatTxDate } from './format';
import { CategoryTag, isUncategorized, TxBadges } from './tx-badges';

// F8 流水列表（设计图 03）：电脑（lg 以上）是表格，窄屏是卡片列表
// 拆过的交易（R16.1）：主行显示"已拆分 N"，下面每个拆分一行，默认展开，可以收起
// 分类和归属人的修改在 M4-8 做，这里只显示

type Props = { items: TransactionListItem[]; today: string };

export function TransactionList({ items, today }: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const rowProps = (tx: TransactionListItem) => ({
    tx,
    today,
    expanded: !collapsed.has(tx.id),
    onToggle: () => toggle(tx.id),
  });

  return (
    <>
      <div className="hidden rounded-lg border lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24 pl-4">日期</TableHead>
              <TableHead className="pr-6 text-right">金额</TableHead>
              <TableHead>分类</TableHead>
              <TableHead>账户</TableHead>
              <TableHead>归属人</TableHead>
              <TableHead className="pr-4">商家</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((tx) => (
              <TableRows key={tx.id} {...rowProps(tx)} />
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2 lg:hidden">
        {items.map((tx) => (
          <TxCard key={tx.id} {...rowProps(tx)} />
        ))}
      </ul>
    </>
  );
}

type RowProps = {
  tx: TransactionListItem;
  today: string;
  expanded: boolean;
  onToggle: () => void;
};

function Amount({ cents, className }: { cents: number; className?: string }) {
  return (
    <span className={cn('tabular-nums', cents > 0 && 'text-green-700', className)}>
      {cents > 0 ? '+' : ''}
      {formatAud(cents)}
    </span>
  );
}

function SplitToggle({
  count,
  expanded,
  onToggle,
}: Omit<RowProps, 'tx' | 'today'> & { count: number }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={expanded}
      onClick={onToggle}
      className="-ml-2 h-7 gap-1 px-2 font-normal"
    >
      已拆分 {count}
      <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
    </Button>
  );
}

function CategoryCell({ split }: { split: SplitView }) {
  return <CategoryTag category={split.category} />;
}

// ---------- 电脑：表格 ----------

function TableRows({ tx, today, expanded, onToggle }: RowProps) {
  const isSplit = tx.splits.length > 1;
  const primary = tx.splits[0];
  const uncategorized = tx.splits.some(isUncategorized);
  return (
    <>
      <TableRow
        className={cn(uncategorized && 'bg-amber-50/60', isSplit && expanded && 'border-b-0')}
      >
        <TableCell className="pl-4 align-top whitespace-nowrap text-muted-foreground">
          {formatTxDate(tx.date, today)}
        </TableCell>
        <TableCell className="pr-6 text-right whitespace-nowrap align-top font-medium">
          <Amount cents={tx.amountCents} />
        </TableCell>
        <TableCell className="align-top">
          {isSplit ? (
            <SplitToggle count={tx.splits.length} expanded={expanded} onToggle={onToggle} />
          ) : (
            primary && <CategoryCell split={primary} />
          )}
        </TableCell>
        <TableCell className="align-top">
          {tx.account.name}
          {tx.cardLast4 && (
            <span className="ml-1 text-xs text-muted-foreground">卡 {tx.cardLast4}</span>
          )}
        </TableCell>
        <TableCell className="align-top">{!isSplit && primary?.member.name}</TableCell>
        <TableCell className="pr-4 align-top whitespace-normal">
          <div className="flex max-w-96 flex-wrap items-center gap-1.5">
            <span className="font-medium break-words">{tx.merchant}</span>
            <TxBadges tx={tx} />
          </div>
          {/* 脱敏后的原始描述（R2.3）。只占一行，悬停看完整的 */}
          <div
            title={tx.rawDescription}
            className="mt-0.5 max-w-96 truncate font-mono text-xs text-muted-foreground"
          >
            {tx.rawDescription}
          </div>
        </TableCell>
      </TableRow>
      {isSplit &&
        expanded &&
        tx.splits.map((s, i) => (
          <TableRow
            key={s.id}
            className={cn(
              'bg-muted/40 text-muted-foreground hover:bg-muted/60',
              i < tx.splits.length - 1 && 'border-b-0',
            )}
          >
            <TableCell className="pl-4" />
            <TableCell className="pr-6 text-right">
              <Amount cents={s.amountCents} />
            </TableCell>
            <TableCell className="text-foreground">
              <CategoryCell split={s} />
            </TableCell>
            <TableCell />
            <TableCell className="text-foreground">{s.member.name}</TableCell>
            <TableCell className="pr-4 whitespace-normal">
              <span className="flex items-center gap-1.5">
                <CornerDownRight className="size-3.5 shrink-0" />
                {s.isPrimary ? '主拆分' : (s.note ?? '拆出的部分')}
              </span>
            </TableCell>
          </TableRow>
        ))}
    </>
  );
}

// ---------- 窄屏：卡片 ----------

function TxCard({ tx, today, expanded, onToggle }: RowProps) {
  const isSplit = tx.splits.length > 1;
  const primary = tx.splits[0];
  const uncategorized = tx.splits.some(isUncategorized);
  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-sm',
        uncategorized && 'border-amber-200 bg-amber-50/60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-medium break-words">{tx.merchant}</span>
          <TxBadges tx={tx} />
        </div>
        <Amount cents={tx.amountCents} className="shrink-0 font-medium" />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{formatTxDate(tx.date, today)}</span>
        <span>·</span>
        <span>{tx.account.name}</span>
        {!isSplit && primary && (
          <>
            <span>·</span>
            <CategoryCell split={primary} />
            <span>·</span>
            <span>{primary.member.name}</span>
          </>
        )}
      </div>
      <div title={tx.rawDescription} className="truncate font-mono text-xs text-muted-foreground">
        {tx.rawDescription}
      </div>
      {isSplit && (
        <div className="text-xs">
          <SplitToggle count={tx.splits.length} expanded={expanded} onToggle={onToggle} />
          {expanded && (
            <ul className="mt-1 flex flex-col gap-1 border-l pl-3">
              {tx.splits.map((s) => (
                <li key={s.id} className="flex items-start justify-between gap-3">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <CategoryCell split={s} />
                    <span className="text-muted-foreground">{s.member.name}</span>
                  </span>
                  <Amount cents={s.amountCents} className="shrink-0" />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
