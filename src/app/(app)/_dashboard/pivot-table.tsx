'use client';

import { ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { CategoryTone } from '@/lib/transactions/category-color';
import { cn } from '@/lib/utils';
import { ToneDot } from '../transactions/tx-badges';

// 汇总表的表格部分（M5-5）。数据和链接在服务端算好，这里只管哪些一级展开了
// 不跳 F8（2026-10-25 改）：有二级的一级，点这一行任意地方（名字或格子）展开收起；其他行点了没反应
// 手机上表格在自己的容器里横向滚动（shadcn Table 自带 overflow-x-auto），第一列固定，页面不滚

export type PivotCellView = { text: string; zero: boolean };
type SubRowView = { id: string; name: string; cells: PivotCellView[] };
export type PivotRowView = SubRowView & { tone: CategoryTone | null; children: SubRowView[] };

type Props = {
  firstHeader: string;
  columns: { label: string; partial: boolean }[];
  rows: PivotRowView[];
  totals: PivotCellView[]; // 列合计，最后一个是总合计
};

// 第一列固定在左边，横向滚动时名字一直看得到
// 能展开的行悬停时每格（含固定列）一起变色，不用 TableRow 自带的整行高亮，免得固定列那格断开
const sticky = 'sticky left-0 z-10 bg-card';
const hoverCell = 'group-hover:bg-muted';

export function PivotTable({ firstHeader, columns, rows, totals }: Props) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Table className="tabular-nums">
      <TableHeader>
        <TableRow>
          <TableHead className={cn(sticky, 'min-w-32 sm:min-w-36')}>{firstHeader}</TableHead>
          {columns.map((c) => (
            <TableHead key={c.label} className="text-right align-bottom">
              <span className="block whitespace-nowrap">{c.label}</span>
              {c.partial && (
                <span className="block text-xs font-normal text-muted-foreground">部分</span>
              )}
            </TableHead>
          ))}
          <TableHead className="text-right align-bottom font-semibold">合计</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const expandable = row.children.length > 0;
          const expanded = open.has(row.id);
          return (
            <Fragment key={row.id}>
              <TableRow
                className={cn('hover:bg-transparent', expandable && 'group cursor-pointer')}
                onClick={expandable ? () => toggle(row.id) : undefined}
              >
                <TableCell className={cn(sticky, 'font-medium', expandable && hoverCell)}>
                  {expandable ? (
                    // 键盘用：按钮的点击冒泡到这一行，由行的 onClick 展开收起
                    <button
                      type="button"
                      aria-expanded={expanded}
                      className="flex max-w-32 items-center gap-1.5 text-left sm:max-w-48"
                    >
                      <ChevronRight
                        aria-hidden
                        className={cn(
                          'size-4 shrink-0 text-muted-foreground transition-transform',
                          expanded && 'rotate-90',
                        )}
                      />
                      {row.tone && <ToneDot tone={row.tone} />}
                      <span className="truncate">{row.name}</span>
                    </button>
                  ) : (
                    <span className="flex max-w-32 items-center gap-1.5 sm:max-w-48">
                      {row.tone && <span aria-hidden className="w-4 shrink-0" />}
                      {row.tone && <ToneDot tone={row.tone} />}
                      <span className="truncate">{row.name}</span>
                    </span>
                  )}
                </TableCell>
                <Cells cells={row.cells} className={expandable ? hoverCell : undefined} />
              </TableRow>
              {expandable &&
                expanded &&
                row.children.map((child) => (
                  <TableRow key={child.id} className="text-muted-foreground hover:bg-transparent">
                    <TableCell className={cn(sticky, 'pl-12')}>
                      <span className="block max-w-28 sm:max-w-40 truncate">{child.name}</span>
                    </TableCell>
                    <Cells cells={child.cells} />
                  </TableRow>
                ))}
            </Fragment>
          );
        })}
      </TableBody>
      <TableFooter className="bg-muted">
        <TableRow className="font-semibold hover:bg-transparent">
          <TableCell className={cn(sticky, 'bg-muted')}>合计</TableCell>
          <Cells cells={totals} />
        </TableRow>
      </TableFooter>
    </Table>
  );
}

// 一行的数字格子，最后一个是行合计（加粗）
function Cells({ cells, className }: { cells: PivotCellView[]; className?: string }) {
  return cells.map((c, i) => (
    <TableCell
      key={i}
      className={cn(
        'text-right',
        c.zero && 'text-muted-foreground/60',
        i === cells.length - 1 && 'font-semibold',
        className,
      )}
    >
      {c.text}
    </TableCell>
  ));
}
