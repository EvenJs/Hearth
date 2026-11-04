import { LifeBuoy } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatAud } from '@/lib/rules/money';
import type { PinnedGoal } from '@/server/goals';
import { MonthlyRequired, ProgressBlock } from '../goals/goal-card';

// F6 看板的固定目标（R25.11）：只有 active 而且固定了的，按 /goals 的顺序（应急金在最前）
// 不跟看板的时间段和归属人筛选；一个都没固定时整块不显示，不留空位

type Props = {
  goals: PinnedGoal[];
  memberSelected: boolean; // 看板选了归属人时标"全家"
};

export function PinnedGoals({ goals, memberSelected }: Props) {
  if (goals.length === 0) return null;

  return (
    <Card className="gap-3 p-4 lg:p-5">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">固定目标</h2>
        {memberSelected && (
          <Badge className="border-transparent bg-muted font-normal text-muted-foreground">
            全家
          </Badge>
        )}
      </div>

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
        {goals.map((g) => (
          <li key={g.id} className="min-w-0">
            <PinnedGoalCard goal={g} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

// 点了去 /goals。应急金没有日期，和 /goals 的应急金卡片一样不显示每月要存
function PinnedGoalCard({ goal: g }: { goal: PinnedGoal }) {
  const remaining = g.progress.remainingCents;
  return (
    <Link
      href="/goals"
      className="flex h-full flex-col gap-2 rounded-lg border p-3 transition-colors hover:bg-muted/50"
    >
      <span className="flex items-center gap-2 text-sm">
        {g.isEmergency && <LifeBuoy className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate">{g.name}</span>
      </span>
      <ProgressBlock progress={g.progress} />
      <dl className="mt-auto flex flex-col gap-1 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">还差</dt>
          <dd className="tabular-nums">
            {remaining === null ? '—' : formatAud(Math.max(remaining, 0))}
          </dd>
        </div>
        {!g.isEmergency && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">每月要存</dt>
            <dd className="text-right">
              <MonthlyRequired goal={g} />
            </dd>
          </div>
        )}
      </dl>
    </Link>
  );
}
