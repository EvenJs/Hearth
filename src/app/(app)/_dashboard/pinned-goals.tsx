import { LifeBuoy } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatAud } from '@/lib/rules/money';
import type { PinnedGoal } from '@/server/goals';
import { AttachAccountButton, MonthlyRequired, ProgressBlock } from '../goals/goal-card';
import type { AccountOption } from '../goals/goals-view';

// F6 看板的固定目标（R25.11）：只有 active 而且固定了的，按 /goals 的顺序（应急金在最前）
// 不跟看板的时间段和归属人筛选；一个都没固定时整块不显示，不留空位
// M13-5：没挂账户的卡片上直接挂；手机上一行横着滑，电脑上照旧网格

type Props = {
  goals: PinnedGoal[];
  accounts: AccountOption[]; // 挂账户下拉：没归档、不是现金的账户
  memberSelected: boolean; // 看板选了归属人时标"全家"
};

export function PinnedGoals({ goals, accounts, memberSelected }: Props) {
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

      <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] lg:overflow-visible lg:px-0 lg:pb-0">
        {goals.map((g) => (
          <li key={g.id} className="w-60 min-w-0 shrink-0 snap-start lg:w-auto">
            <PinnedGoalCard goal={g} accounts={accounts} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

// 点了去 /goals。应急金没有日期，和 /goals 的应急金卡片一样不显示每月要存
// Link 里不能放按钮：名字的 Link 用 after: 盖住整张卡片，挂账户按钮 relative z-10 浮在上面，点它不跳
function PinnedGoalCard({ goal: g, accounts }: { goal: PinnedGoal; accounts: AccountOption[] }) {
  const remaining = g.progress.remainingCents;
  return (
    <div className="relative flex h-full flex-col gap-2 rounded-lg border p-3 transition-colors hover:bg-muted/50">
      <Link
        href="/goals"
        className="flex items-center gap-2 text-sm after:absolute after:inset-0 after:rounded-lg"
      >
        {g.isEmergency && <LifeBuoy className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate">{g.name}</span>
      </Link>
      <ProgressBlock
        progress={g.progress}
        attach={
          <div className="relative z-10">
            <AttachAccountButton goal={g} accounts={accounts} />
          </div>
        }
      />
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
    </div>
  );
}
