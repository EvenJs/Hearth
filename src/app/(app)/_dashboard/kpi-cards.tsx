import { ArrowRight, Clock } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  formatPercentChange,
  formatPointsChange,
  formatRange,
  formatSavingsRate,
} from '@/lib/dashboard/format';
import { kpiLink, type DashboardScope, type KpiKind } from '@/lib/dashboard/links';
import { formatAud } from '@/lib/rules/money';
import { cn } from '@/lib/utils';
import { transactionsHref } from '../transactions/href';
import type { Dashboard } from '@/server/dashboard';

// F6 看板的 4 张 KPI（R10）和"含 N 笔待确认交易"（R10.6）
// 每个数字都能点进 F8（src/lib/dashboard/links.ts）；储蓄率是比率不是合计，不跳
// 对比上期（R10.4）涨跌都用灰色；未分类不对比

type Props = { dashboard: Dashboard; scope: DashboardScope; today: string };

export function KpiCards({ dashboard, scope, today }: Props) {
  const { current, comparison, previous } = dashboard;
  const href = (kind: KpiKind) => transactionsHref(kpiLink(scope, kind));
  const prevTitle = `上期：${formatRange(previous, today)}`;

  return (
    <section aria-label="收支概览" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      <Kpi label="收入">
        <Big href={href('income')}>{formatAud(current.incomeCents)}</Big>
        <Sub>
          其中税前{' '}
          <Link href={href('pre_tax')} className="tabular-nums underline-offset-4 hover:underline">
            {formatAud(current.preTaxIncomeCents)}
          </Link>
        </Sub>
        <Change title={prevTitle}>{formatPercentChange(comparison.incomePercent)}</Change>
      </Kpi>

      <Kpi label="支出">
        <Big href={href('expense')}>{formatAud(current.expenseCents)}</Big>
        <Sub>&nbsp;</Sub>
        <Change title={prevTitle}>{formatPercentChange(comparison.expensePercent)}</Change>
      </Kpi>

      <Kpi label="储蓄率">
        <p className="text-xl font-semibold tabular-nums sm:text-2xl">
          {formatSavingsRate(current.savingsRate)}
        </p>
        <Sub>(收入 − 支出) ÷ 收入</Sub>
        <Change title={prevTitle}>{formatPointsChange(comparison.savingsRatePoints)}</Change>
      </Kpi>

      <Kpi label="未分类">
        <Big
          href={href('uncategorized')}
          className={current.uncategorized.count > 0 ? 'text-amber-700' : undefined}
        >
          {current.uncategorized.count} 笔
        </Big>
        <Sub>
          <Link
            href={href('uncategorized')}
            className="tabular-nums underline-offset-4 hover:underline"
          >
            {formatAud(current.uncategorized.amountCents)}
          </Link>
          <span className="text-muted-foreground"> · 不计入收支</span>
        </Sub>
        <Link
          href={href('uncategorized')}
          className="mt-auto inline-flex items-center gap-1 pt-2 text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          去处理
          <ArrowRight className="size-3.5" />
        </Link>
      </Kpi>
    </section>
  );
}

// R10.6：时间段内、命中当前归属人筛选的 pending 交易笔数；没有时不显示
export function PendingNote({ count, scope }: { count: number; scope: DashboardScope }) {
  if (count === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <Clock className="size-4" />
      <Link
        href={transactionsHref(kpiLink(scope, 'pending'))}
        className="underline-offset-4 hover:text-foreground hover:underline"
      >
        含 <strong className="text-foreground tabular-nums">{count}</strong> 笔待确认交易
      </Link>
      <Badge className="border-transparent bg-muted font-normal text-muted-foreground">
        <Clock />
        待确认
      </Badge>
    </p>
  );
}

function Kpi({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card className="min-w-0 gap-1 p-4 lg:p-5">
      <h2 className="text-sm text-muted-foreground">{label}</h2>
      {children}
    </Card>
  );
}

function Big({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'w-fit text-xl font-semibold tabular-nums underline-offset-4 hover:underline sm:text-2xl',
        className,
      )}
    >
      {children}
    </Link>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <p className="truncate text-xs text-muted-foreground">{children}</p>;
}

// R10.4 对比上期，灰色；hover 显示上期的起止日期
function Change({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <p className="mt-auto pt-2 text-xs text-muted-foreground" title={title}>
      <span className="font-medium tabular-nums">{children}</span> 对比上期
    </p>
  );
}
