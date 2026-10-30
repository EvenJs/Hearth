import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { BudgetOverview } from '@/lib/rules/budget';
import { formatAud } from '@/lib/rules/money';
import type { BudgetLevel } from '@/lib/rules/stats';
import { cn } from '@/lib/utils';
import type { BudgetItem } from '@/server/budgets';
import { transactionsHref } from '../transactions/href';

// F6 看板顶部的预算区块（设计图 02，R11.3）：固定是本月、全家，不跟看板的时间段和归属人筛选
// 固定的预算每个一条；合计那一行是 R11.1 所有预算的合计，不只是固定的那几个
// 一个预算都没有时整块不显示；没有固定的只显示合计

type Props = {
  budgets: BudgetItem[]; // 已经按分类顺序排好
  overview: BudgetOverview;
  memberSelected: boolean; // 看板选了归属人时标"全家"
};

// R11：ok 正常色、warn 琥珀色、over 红色（同设置页 budgets-view.tsx）
const BAR: Record<BudgetLevel, string> = {
  ok: 'bg-primary',
  warn: 'bg-amber-500',
  over: 'bg-destructive',
};
const PERCENT_TEXT: Record<BudgetLevel, string> = {
  ok: 'text-muted-foreground',
  warn: 'text-amber-700',
  over: 'text-destructive',
};

export function PinnedBudgets({ budgets, overview, memberSelected }: Props) {
  if (budgets.length === 0) return null;
  const pinned = budgets.filter((b) => b.isPinned);
  const { spentCents, limitCents, remainingCents } = overview;

  return (
    <Card className="gap-3 p-4 lg:p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">置顶预算</h2>
          <span className="text-xs text-muted-foreground">本月</span>
          {memberSelected && (
            <Badge className="border-transparent bg-muted font-normal text-muted-foreground">
              全家
            </Badge>
          )}
        </div>
        <Link
          href="/settings/budgets"
          className="text-sm tabular-nums underline-offset-4 hover:underline sm:ml-auto"
        >
          预算 {formatAud(spentCents)}
          <span className="text-muted-foreground"> / {formatAud(limitCents)}</span>，还剩{' '}
          <span className={cn('font-medium', remainingCents < 0 && 'text-destructive')}>
            {formatAud(remainingCents)}
          </span>
          <ArrowRight className="ml-1 inline size-3.5 align-[-2px] text-muted-foreground" />
        </Link>
      </div>

      {pinned.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
          {pinned.map((b) => (
            <li key={b.id} className="min-w-0">
              <PinnedBudget budget={b} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// 点了去 F8：本月、这个分类（一级包含它的二级，和一级预算的口径一样）
// 条宽卡在 0–100%（负数是空条），百分比照实显示（180%、-20%）
function PinnedBudget({ budget }: { budget: BudgetItem }) {
  const { spentCents, limitCents, percent, level } = budget.progress;
  const width = Math.min(Math.max(percent, 0), 100);
  return (
    <Link
      href={transactionsHref({ period: 'this_month', categoryId: budget.categoryId })}
      className="flex flex-col gap-2 rounded-lg border p-3 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate">{budget.label}</span>
        <span className={cn('shrink-0 tabular-nums', PERCENT_TEXT[level])}>
          {Math.round(percent)}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', BAR[level])} style={{ width: `${width}%` }} />
      </div>
      <div className="flex items-baseline justify-between gap-2 tabular-nums">
        <span className="font-semibold">{formatAud(spentCents)}</span>
        <span className="text-xs text-muted-foreground">预算 {formatAud(limitCents)}</span>
      </div>
    </Link>
  );
}
