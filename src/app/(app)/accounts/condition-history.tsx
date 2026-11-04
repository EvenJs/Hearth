'use client';

import { useLayoutEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  CONDITION_OUTCOMES,
  MONTH_CELL_LABELS,
  outcomeSummaryText,
  type ConditionStatus,
} from '@/lib/rules/conditions';
import { formatAud } from '@/lib/rules/money';
import { cn } from '@/lib/utils';
import type { AccountConditionProgress, ConditionMonth } from '@/server/conditions';
import { ConditionRow, FeeMismatchNote } from './condition-progress';

// R24.10 历史：最近 12 个月（含本月）每月一个小格，按账户合并的状态；点开看那个月
// 从最早的 effective_from 开始（getConditionProgress 已经筛好），中间没条件的月份是空格子

const CELL_CLASSES: Record<ConditionStatus, string> = {
  met: 'bg-emerald-600 dark:bg-emerald-500',
  failed: 'bg-destructive',
  in_progress: 'border-2 border-primary bg-primary/15',
  unknown: 'bg-muted-foreground/35',
};

const LEGEND: ConditionStatus[] = ['met', 'failed', 'in_progress', 'unknown'];

const monthLabel = (month: string) => month.slice(0, 7); // 2026-10
const monthNumber = (month: string) => String(Number(month.slice(5, 7))); // 10

function cellLabel(m: ConditionMonth): string {
  const status = m.summary.overall === null ? '没有条件' : MONTH_CELL_LABELS[m.summary.overall];
  return `${monthLabel(m.month)} ${status}${m.feeMismatchCents !== null ? '，有月费提示' : ''}`;
}

export function ConditionHistory({ progress }: { progress: AccountConditionProgress }) {
  // 存月份不存那个月的数据：勾了"其他"、页面刷新后，弹窗里跟着变
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  // 离开页面时关掉弹窗（cacheComponents 的 Activity 会保留 state，tech-stack 2）
  useLayoutEffect(() => () => setOpenMonth(null), []);

  if (progress.history.length === 0) return null;
  const selected = progress.history.find((m) => m.month === openMonth) ?? null;

  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs text-muted-foreground">最近 12 个月</h4>
      <ol className="grid grid-cols-12 gap-1">
        {progress.history.map((m) => {
          const status = m.summary.overall;
          return (
            <li key={m.month} className="min-w-0">
              <button
                type="button"
                title={cellLabel(m)}
                aria-label={cellLabel(m)}
                onClick={() => setOpenMonth(m.month)}
                className="flex w-full flex-col items-center gap-0.5 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span
                  className={cn(
                    'relative block aspect-square w-full rounded-sm',
                    status === null ? 'border border-dashed' : CELL_CLASSES[status],
                  )}
                >
                  {/* R24.8：有月费提示的月份标出来 */}
                  {m.feeMismatchCents !== null && (
                    <span className="absolute -top-1 -right-1 size-2 rounded-full bg-amber-500 ring-2 ring-card" />
                  )}
                </span>
                <span className="text-[10px] leading-none text-muted-foreground tabular-nums">
                  {monthNumber(m.month)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {LEGEND.map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className={cn('size-2.5 rounded-xs', CELL_CLASSES[s])} />
            {MONTH_CELL_LABELS[s]}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-amber-500" />
          月费提示
        </span>
      </p>

      <Dialog open={selected !== null} onOpenChange={(o) => !o && setOpenMonth(null)}>
        {selected !== null && <MonthDetail progress={progress} month={selected} />}
      </Dialog>
    </div>
  );
}

// R24.10 点开看那个月：每个条件的状态和文字、按结果合并的结论、月费提示、当月利息
function MonthDetail({
  progress,
  month: m,
}: {
  progress: AccountConditionProgress;
  month: ConditionMonth;
}) {
  return (
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>
          {progress.accountName} · <span className="tabular-nums">{monthLabel(m.month)}</span>
        </DialogTitle>
        <DialogDescription>每个条件这个月的结果，按当时生效的条件算。</DialogDescription>
      </DialogHeader>

      {m.results.length === 0 ? (
        <p className="text-sm text-muted-foreground">这个月没有在判断的条件</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
            {CONDITION_OUTCOMES.map((o) => {
              const status = m.summary.byOutcome[o];
              return status === undefined ? null : (
                <span key={o}>{outcomeSummaryText(o, status)}</span>
              );
            })}
          </div>
          <ul className="flex flex-col gap-3 border-t pt-3">
            {m.results.map((r) => (
              <ConditionRow
                key={r.conditionId}
                result={r}
                condition={progress.conditions.find((c) => c.id === r.conditionId)!}
              />
            ))}
          </ul>
        </>
      )}
      {m.feeMismatchCents !== null && <FeeMismatchNote cents={m.feeMismatchCents} />}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-t pt-3 text-sm">
        <dt className="text-muted-foreground">当月利息</dt>
        <dd className="text-right tabular-nums">{formatAud(m.interestCents)}</dd>
      </dl>
    </DialogContent>
  );
}
