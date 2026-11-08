'use client';

import { CircleCheck, CircleDashed, CircleHelp, CircleX, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { conditionText } from '@/lib/accounts/condition-text';
import {
  OUTCOME_LABELS,
  asOfLabel,
  describeCondition,
  feeMismatchText,
  monthEndPendingNote,
  unknownDepositNote,
  unmatchedPendingNote,
  type ConditionResult,
  type ConditionStatus,
} from '@/lib/rules/conditions';
import { cn } from '@/lib/utils';
import type { AccountConditionProgress, StoredCondition } from '@/server/conditions';
import { setManualCheckAction } from './actions';

// R24.10 账户卡片下面的"本月条件"：每个条件一行，类型说明 + 结果 + 状态文字 + 数据截至
// 只读，唯一能改的是"其他"的手动勾（R24.7）；配置在设置页

const STATUS_ICONS: Record<ConditionStatus, typeof CircleCheck> = {
  met: CircleCheck,
  failed: CircleX,
  in_progress: CircleDashed,
  unknown: CircleHelp,
};

const STATUS_CLASSES: Record<ConditionStatus, string> = {
  met: 'text-emerald-700 dark:text-emerald-400',
  failed: 'text-destructive',
  in_progress: 'text-foreground',
  unknown: 'text-muted-foreground',
};

type Props = { progress: AccountConditionProgress };

export function ConditionProgress({ progress }: Props) {
  const current = progress.thisMonth;
  return (
    <section aria-label="本月条件" className="flex flex-col gap-2 border-t pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium">本月条件</h4>
        <Link
          href={`/settings/accounts?edit=${progress.accountId}`}
          className="shrink-0 text-xs text-primary underline-offset-4 hover:underline"
        >
          去设置
        </Link>
      </div>
      {current === null ? (
        <p className="text-xs text-muted-foreground">本月没有在判断的条件</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2.5">
            {current.results.map((r) => (
              <ConditionRow
                key={r.conditionId}
                result={r}
                condition={findCondition(progress, r.conditionId)}
              />
            ))}
          </ul>
          {current.feeMismatchCents !== null && (
            <FeeMismatchNote cents={current.feeMismatchCents} />
          )}
        </>
      )}
    </section>
  );
}

function findCondition(progress: AccountConditionProgress, id: string): StoredCondition {
  return progress.conditions.find((c) => c.id === id)!;
}

// 一个条件一个月的结果。历史点开也用这一行
export function ConditionRow({
  result: r,
  condition,
}: {
  result: ConditionResult;
  condition: StoredCondition;
}) {
  const Icon = STATUS_ICONS[r.status];
  // R24.3、R24.5 的小字，N 是 0 的是 null
  const notes = [unknownDepositNote(r), unmatchedPendingNote(r), monthEndPendingNote(r)].filter(
    (n) => n !== null,
  );
  return (
    <li className="flex min-w-0 flex-col gap-0.5 text-sm">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <p className="min-w-0 text-xs break-words text-muted-foreground">
          {conditionText(condition)}
        </p>
        <Badge variant="secondary">{OUTCOME_LABELS[condition.outcome]}</Badge>
      </div>
      <p className={cn('flex min-w-0 items-start gap-1.5', STATUS_CLASSES[r.status])}>
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 break-words tabular-nums">{describeCondition(r)}</span>
      </p>
      <p className="text-xs text-muted-foreground tabular-nums">{asOfLabel(r.asOf)}</p>
      {notes.map((n) => (
        <p key={n} className="text-xs break-words text-muted-foreground">
          {n}
        </p>
      ))}
      {r.type === 'other' && <ManualCheckButtons result={r} />}
    </li>
  );
}

// R24.7：满足了 / 没满足 / 清掉。清掉 = 回到还没勾
function ManualCheckButtons({ result: r }: { result: ConditionResult }) {
  const [pending, startTransition] = useTransition();
  const checked = r.status === 'met' ? true : r.status === 'failed' ? false : null;

  function set(isMet: boolean | null) {
    startTransition(async () => {
      const result = await setManualCheckAction(r.conditionId, r.month, isMet);
      if (!result.ok) {
        toast.error(result.errors.month ?? result.errors.form ?? '保存失败，请稍后再试');
      }
    });
  }

  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      <Button
        size="xs"
        variant={checked === true ? 'default' : 'outline'}
        aria-pressed={checked === true}
        disabled={pending}
        onClick={() => set(true)}
      >
        满足了
      </Button>
      <Button
        size="xs"
        variant={checked === false ? 'default' : 'outline'}
        aria-pressed={checked === false}
        disabled={pending}
        onClick={() => set(false)}
      >
        没满足
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={pending || checked === null}
        onClick={() => set(null)}
      >
        清掉
      </Button>
    </div>
  );
}

// R24.8
export function FeeMismatchNote({ cents }: { cents: number }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words tabular-nums">{feeMismatchText(cents)}</span>
    </p>
  );
}
