'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { CategoryTone } from '@/lib/transactions/category-color';
import { cn } from '@/lib/utils';
import { toneBarClass, ToneDot } from '../transactions/tx-badges';

// 支出分类列表的展开收起（M5-4）。数据在服务端算好，这里只管哪些一级展开了
// 有二级的一级点了只展开收起；二级行、没有二级的一级行点进 F8
// 展开收起离开再回来保留（tech-stack 2 页面状态）：Activity 默认就留着 state，不用处理

type Line = {
  id: string;
  name: string;
  amount: string;
  negative: boolean; // 退款大于支出，照实显示
  share: number | null; // 0 到 1；null = 没有占比，不画条
  shareText: string;
  href: string | null; // null = 不能点（"X（不细分）"那一行）
};

export type CategoryRow = Line & { tone: CategoryTone; children: Line[] };

export function CategoryList({ rows }: { rows: CategoryRow[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row) => {
        const expanded = open.has(row.id);
        const expandable = row.children.length > 0;
        const childrenId = `category-children-${row.id}`;
        const dot = <ToneDot tone={row.tone} />;
        return (
          <li key={row.id}>
            {/* 有二级的一级：整行点击只展开收起，不跳 F8（2026-10-24 改）
                没有二级的（现金支出、银行费用等）没东西可展开，还是点进 F8 */}
            {expandable ? (
              <button
                type="button"
                onClick={() => toggle(row.id)}
                aria-expanded={expanded}
                aria-controls={childrenId}
                className={cn(rowClass(true), 'w-full text-left')}
              >
                <LineContent
                  line={row}
                  barClass={toneBarClass(row.tone)}
                  lead={
                    <ChevronRight
                      aria-hidden
                      className={cn(
                        'size-4 shrink-0 text-muted-foreground transition-transform',
                        expanded && 'rotate-90',
                      )}
                    />
                  }
                >
                  {dot}
                </LineContent>
              </button>
            ) : (
              <LineRow
                line={row}
                barClass={toneBarClass(row.tone)}
                lead={<span aria-hidden className="w-4 shrink-0" />}
              >
                {dot}
              </LineRow>
            )}
            {expandable && expanded && (
              <ul id={childrenId} className="mb-1 flex flex-col pl-8">
                {row.children.map((child) => (
                  <li key={child.id}>
                    <LineRow
                      line={child}
                      barClass={cn(toneBarClass(row.tone), 'opacity-50')}
                      small
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function rowClass(interactive: boolean, small?: boolean): string {
  return cn(
    'group flex min-w-0 flex-col gap-1.5 rounded-md px-2',
    interactive && 'hover:bg-muted/60',
    small ? 'py-1.5' : 'py-2',
  );
}

// 二级行、没有二级的一级行：有 href 整行点进 F8；没有 href（"X（不细分）"）只显示
function LineRow(props: {
  line: Line;
  barClass: string;
  small?: boolean;
  lead?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const { line, small } = props;
  return line.href ? (
    <Link href={line.href} className={rowClass(true, small)}>
      <LineContent {...props} />
    </Link>
  ) : (
    <div className={rowClass(false, small)}>
      <LineContent {...props} />
    </div>
  );
}

// 一行的内容：名字、占比、金额，下面是进度条
function LineContent({
  line,
  barClass,
  small,
  lead,
  children,
}: {
  line: Line;
  barClass: string;
  small?: boolean;
  lead?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const clickable = line.href !== null;
  return (
    <>
      <span
        className={cn('flex min-w-0 items-center gap-2', small ? 'text-sm' : 'text-sm font-medium')}
      >
        {lead}
        {children}
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            clickable ? 'underline-offset-4 group-hover:underline' : 'text-muted-foreground',
          )}
        >
          {line.name}
        </span>
        <span className="w-11 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:w-14">
          {line.shareText}
        </span>
        <span
          className={cn(
            'w-[4.75rem] shrink-0 text-right tabular-nums sm:w-24',
            line.negative && 'text-muted-foreground',
          )}
        >
          {line.amount}
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          'block overflow-hidden rounded-full bg-muted',
          small ? 'h-1' : 'h-1.5',
          lead ? 'ml-6' : undefined,
        )}
      >
        {line.share !== null && line.share > 0 && (
          <span
            className={cn('block h-full rounded-full', barClass)}
            style={{ width: `${Math.max(line.share * 100, 1)}%` }}
          />
        )}
      </span>
    </>
  );
}
