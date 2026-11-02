'use client';

import { ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatPercentChange } from '@/lib/dashboard/format';
import { formatAud } from '@/lib/rules/money';
import { cn } from '@/lib/utils';
import type { AverageCells, MonthlyAverageCard } from '@/server/monthly-average';
import { ToneDot, toneOfTop } from '../transactions/tx-badges';

// F11 月均支出卡片（M7.7-7，R22.5 到 R22.9）：样子照汇总表，不出设计图（R22.8）
// 两个窗口各写"基于 n 个月"；本月排除一次性，对比近 12 个月月均，灰色（R10.4）
// 分类 / 归属人切换是这张卡片自己的 state，不写进 URL，不影响别的卡片
// 按分类时有二级的一级点这一行展开收起（同汇总表）；不跳 F8
// 数据跟归属人筛选，不跟时间段（R22.8），由 page.tsx 传进来

type Props = { data: MonthlyAverageCard | null };

type Dimension = 'category' | 'member';

const DIMENSIONS: { value: Dimension; label: string }[] = [
  { value: 'category', label: '按分类' },
  { value: 'member', label: '按归属人' },
];

type SubRowView = { id: string; name: string; cells: AverageCells };
type RowView = SubRowView & { tone: ReturnType<typeof toneOfTop> | null; children: SubRowView[] };

const sticky = 'sticky left-0 z-10 bg-card';
const hoverCell = 'group-hover:bg-muted';

export function MonthlyAverage({ data }: Props) {
  const [dimension, setDimension] = useState<Dimension>('category');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (data === null) {
    return (
      <Card className="min-w-0 gap-4 p-4 lg:p-6">
        <h2 className="text-lg font-semibold">月均支出</h2>
        <p className="py-6 text-center text-sm text-muted-foreground">还没有完整月的数据</p>
      </Card>
    );
  }

  const { categories } = data;
  // R22.6：归档分类照列，名字后面标"已归档"
  const categoryName = (id: string) => {
    const c = categories[id];
    if (!c) return '（分类已删除）';
    return c.isArchived ? `${c.nameEn}（已归档）` : c.nameEn;
  };
  const memberName = (id: string) =>
    data.members.find((m) => m.id === id)?.name ?? '（归属人已删除）';

  const rows: RowView[] =
    dimension === 'category'
      ? data.byCategory.map((r) => {
          const top = categories[r.key];
          return {
            id: r.key,
            name: categoryName(r.key),
            tone: top
              ? toneOfTop({
                  id: top.id,
                  nameEn: top.nameEn,
                  kind: top.kind,
                  systemKey: top.systemKey,
                })
              : 'system',
            cells: r,
            children: r.children.map((c) => ({
              id: c.unsplit ? `${c.categoryId}-unsplit` : c.categoryId,
              name: c.unsplit
                ? `${categoryName(c.categoryId)}（不细分）`
                : categoryName(c.categoryId),
              cells: c,
            })),
          };
        })
      : data.byMember.map((r) => ({
          id: r.key,
          name: memberName(r.key),
          tone: null,
          cells: r,
          children: [],
        }));

  return (
    <Card className="min-w-0 gap-4 p-4 lg:p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold">月均支出</h2>
          <span className="text-sm text-muted-foreground">不含一次性开销</span>
        </div>
        <div
          role="group"
          aria-label="维度"
          className="flex w-fit gap-1 rounded-lg border bg-card p-1"
        >
          {DIMENSIONS.map((d) => (
            <Button
              key={d.value}
              type="button"
              size="sm"
              variant={dimension === d.value ? 'default' : 'ghost'}
              aria-pressed={dimension === d.value}
              className="h-7 px-3"
              onClick={() => setDimension(d.value)}
            >
              {d.label}
            </Button>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3 lg:gap-4">
        <Stat label="近 12 个月月均" note={`基于 ${data.months12} 个月`}>
          {formatAud(data.total.avg12Cents)}
        </Stat>
        <Stat label="近 3 个月月均" note={`基于 ${data.months3} 个月`}>
          {formatAud(data.total.avg3Cents)}
        </Stat>
        <Stat
          label="本月"
          note={`${formatPercentChange(data.total.percent)} 对比近 12 个月月均`}
          className="col-span-2 lg:col-span-1"
        >
          {formatAud(data.total.currentCents)}
        </Stat>
      </dl>
      <p className="-mt-2 text-xs text-muted-foreground">本月到今天，还没过完</p>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">近 12 个月和本月都没有支出</p>
      ) : (
        <Table className="tabular-nums">
          <TableHeader>
            <TableRow>
              <TableHead className={cn(sticky, 'min-w-32 sm:min-w-36')}>
                {dimension === 'category' ? '分类' : '归属人'}
              </TableHead>
              <TableHead className="text-right">近 12 月均</TableHead>
              <TableHead className="text-right">近 3 月均</TableHead>
              <TableHead className="text-right">本月</TableHead>
              <TableHead className="text-right">对比</TableHead>
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
                      <TableRow
                        key={child.id}
                        className="text-muted-foreground hover:bg-transparent"
                      >
                        <TableCell className={cn(sticky, 'pl-12')}>
                          <span className="block max-w-28 truncate sm:max-w-40">{child.name}</span>
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
              <Cells cells={data.total} />
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </Card>
  );
}

function Stat({
  label,
  note,
  className,
  children,
}: {
  label: string;
  note: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('min-w-0 rounded-lg border p-3', className)}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{children}</dd>
      <dd className="truncate text-xs text-muted-foreground tabular-nums">{note}</dd>
    </div>
  );
}

// 近 12 月均、近 3 月均、本月、对比；对比灰色（R22.9 颜色同 R10.4）
function Cells({ cells, className }: { cells: AverageCells; className?: string }) {
  const amounts = [cells.avg12Cents, cells.avg3Cents, cells.currentCents];
  return (
    <>
      {amounts.map((cents, i) => (
        <TableCell
          key={i}
          className={cn('text-right', cents === 0 && 'text-muted-foreground/60', className)}
        >
          {formatAud(cents)}
        </TableCell>
      ))}
      <TableCell className={cn('text-right text-muted-foreground', className)}>
        {formatPercentChange(cells.percent)}
      </TableCell>
    </>
  );
}
