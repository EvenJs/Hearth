'use client';

// R25.6 应急金卡片，放在 /goals 最上面（R25.11）：目标金额（月均 × 月数）、进度、还差、能撑几个月、挂的账户
// 应急金永远排第 1，不能上下移动、不能完成。没有应急金时显示"设一个应急金"
import { LifeBuoy, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatAud } from '@/lib/rules/money';
import type { EmergencyGoal } from '@/server/goals';
import { GoalMenu, PinSwitch, ProgressBlock, type GoalAction } from './goal-card';

// 能撑几个月 × 10 → "3.4"，整数算
function formatTenths(tenths: number): string {
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

type Props = {
  goal: EmergencyGoal | null;
  onCreate: () => void;
  onAction: (a: GoalAction) => void;
};

export function EmergencyCard({ goal: g, onCreate, onAction }: Props) {
  if (g === null) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        <LifeBuoy className="size-6" />
        还没有应急金。目标金额按近 12 个月月均 × 月数自动算。
        <Button onClick={onCreate}>
          <Plus />
          设一个应急金
        </Button>
      </div>
    );
  }

  const p = g.progress;
  return (
    <Card className="min-w-0 gap-4 p-4 lg:p-5">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="flex items-center gap-2 font-medium">
            <LifeBuoy className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{g.name}</span>
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {g.account === null
              ? '没挂账户'
              : `${g.account.name}${g.account.isArchived ? '（已归档）' : ''}`}
          </p>
        </div>
        <GoalMenu goal={g} onAction={onAction} />
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] md:items-start">
        <ProgressBlock progress={p} />
        <Stat label="目标金额">
          {p.targetCents === null || g.average === null ? (
            <span className="text-muted-foreground">还没有月均</span>
          ) : (
            <>
              <span className="tabular-nums">{formatAud(p.targetCents)}</span>
              <span className="block text-xs font-normal text-muted-foreground">
                月均 <span className="tabular-nums">{formatAud(g.average.totalCents)}</span> ×{' '}
                <span className="tabular-nums">{g.emergencyMonths}</span> 个月
              </span>
            </>
          )}
        </Stat>
        <Stat label="还差">
          {p.remainingCents === null ? '—' : formatAud(Math.max(p.remainingCents, 0))}
        </Stat>
        {/* 没挂账户不显示能撑几个月（R25.6） */}
        {g.account !== null && (
          <Stat label="能撑">
            {g.monthsCoveredTenths === null ? (
              '—'
            ) : (
              <>
                <span className="tabular-nums">{formatTenths(g.monthsCoveredTenths)}</span> 个月
              </>
            )}
          </Stat>
        )}
      </div>

      <div className="flex items-center gap-3 border-t pt-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <PinSwitch goal={g} />
          固定到首页
        </label>
      </div>
    </Card>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{children}</span>
    </div>
  );
}
