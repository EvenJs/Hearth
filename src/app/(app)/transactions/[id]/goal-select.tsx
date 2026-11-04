'use client';

// R25.7 支出拆分"挂到目标"：只列 active 的 spend 目标，加"不挂"
// 挂上时服务端同时勾一次性，刷新后勾选框跟着变；取消挂不动一次性
// 挂的目标已经完成（R25.9）：不能再改，只显示名字和"去目标页看"
import Link from 'next/link';
import { useOptimistic, useTransition } from 'react';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { SplitView } from '@/server/transactions';
import { linkSplitGoalAction } from './actions';

export type LinkableGoal = { id: string; name: string };

const NONE = 'none'; // Radix Select 的值不能是空字符串

export function GoalSelect({
  split,
  goals,
  className,
}: {
  split: SplitView;
  goals: readonly LinkableGoal[];
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [goalId, setGoalId] = useOptimistic(split.goal?.id ?? null);

  function change(value: string) {
    const next = value === NONE ? null : value;
    if (next === goalId) return;
    startTransition(async () => {
      setGoalId(next);
      const r = await linkSplitGoalAction({ splitId: split.id, goalId: next });
      if (!r.ok) toast.error(r.message);
    });
  }

  const done = split.goal?.status === 'done' && goalId === split.goal.id;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      {done ? (
        <span className="truncate text-sm" title={split.goal?.name}>
          {split.goal?.name}
          <span className="ml-1 text-muted-foreground">（已完成）</span>
        </span>
      ) : (
        <Select value={goalId ?? NONE} onValueChange={change} disabled={pending}>
          <SelectTrigger size="sm" className="w-full bg-background" aria-label="挂到目标">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>不挂</SelectItem>
            {goals.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <GoalHint goalId={goalId} done={done} noGoals={goals.length === 0} />
    </div>
  );
}

function GoalHint({
  goalId,
  done,
  noGoals,
}: {
  goalId: string | null;
  done: boolean;
  noGoals: boolean;
}) {
  const link = 'underline underline-offset-2 hover:text-foreground';
  if (goalId === null) {
    if (!noGoals) return null;
    return (
      <span className="text-xs text-muted-foreground">
        还没有要花掉的目标，
        <Link href="/goals" className={link}>
          去建一个
        </Link>
      </span>
    );
  }
  // 已完成的在折叠的"已完成"里，跳到页面就行
  if (done) {
    return (
      <Link href="/goals" className={cn('w-fit text-xs text-muted-foreground', link)}>
        去目标页看
      </Link>
    );
  }
  const href = `/goals#goal-${goalId}`;
  return (
    <span className="flex flex-col text-xs text-muted-foreground">
      <span>挂了目标，自动标一次性</span>
      <span>
        <Link href={href} className={link}>
          去目标页看
        </Link>
        {' · '}
        <Link href={href} className={link}>
          买完了吗？去完成
        </Link>
      </span>
    </span>
  );
}
