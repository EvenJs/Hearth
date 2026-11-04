'use client';

// R25.11 一个 active 目标的卡片：进度（R25.3）、还差和每月要存（R25.2）、预计达成（R25.4）
// 要花掉的加计划和实际、挂的交易（R25.7），挂了交易时提示"买完了吗？"（R25.9）
// 上移下移、固定开关直接保存；编辑、完成、删除交给 goals-view 开对话框
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import type { GoalProgress, GoalSpend, NoProgressReason, Projection } from '@/lib/rules/goals';
import { formatAud } from '@/lib/rules/money';
import { cn } from '@/lib/utils';
import type { ActiveGoal, GoalInput, GoalRecord, LinkedSplit } from '@/server/goals';
import { moveGoalAction, updateGoalAction } from './actions';

export const NO_PROGRESS_LABELS: Record<NoProgressReason, string> = {
  no_account: '没挂账户',
  no_balance: '账户还没有余额',
  archived: '账户已归档',
  no_average: '还没有月均',
};

// R25.9：挂了交易的只能完成
export const DELETE_BLOCKED = '挂了交易的目标不能删，可以点完成';

// 现在的值原样传回去（updateGoal 要完整的输入）。账户没变，R25.1 第 9 到 11 条不重新校验
export function goalInput(g: GoalRecord): GoalInput {
  return {
    name: g.name,
    kind: g.kind,
    recurrence: g.recurrence,
    targetCents: g.targetCents,
    targetDate: g.targetDate,
    accountId: g.account?.id ?? null,
    emergencyMonths: g.emergencyMonths,
    isPinned: g.isPinned,
  };
}

export type GoalAction =
  | { name: 'edit'; goal: GoalRecord }
  | { name: 'complete'; goal: GoalRecord }
  | { name: 'delete'; goal: GoalRecord };

type Props = {
  goal: ActiveGoal;
  isFirst: boolean;
  isLast: boolean;
  onAction: (a: GoalAction) => void;
};

export function GoalCard({ goal: g, isFirst, isLast, onAction }: Props) {
  return (
    <Card className="min-w-0 gap-3 p-4 lg:p-5">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate font-medium">{g.name}</h3>
            <Badge variant="secondary">{g.kind === 'keep' ? '存着的' : '要花掉的'}</Badge>
            {g.recurrence === 'yearly' && <Badge variant="outline">每年</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {g.account === null
              ? '没挂账户'
              : `${g.account.name}${g.account.isArchived ? '（已归档）' : ''}`}
            {g.targetDate && (
              <>
                {' · 目标日期 '}
                <span className="tabular-nums">{g.targetDate}</span>
              </>
            )}
          </p>
        </div>
        <MoveButtons goal={g} isFirst={isFirst} isLast={isLast} />
        <GoalMenu goal={g} onAction={onAction} />
      </div>

      <ProgressBlock progress={g.progress} />

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">还差</dt>
        <dd className="text-right tabular-nums">
          {g.progress.remainingCents === null
            ? '—'
            : formatAud(Math.max(g.progress.remainingCents, 0))}
        </dd>
        <dt className="text-muted-foreground">每月要存</dt>
        <dd className="text-right">
          <MonthlyRequired goal={g} />
        </dd>
        {g.projection.kind !== 'no_progress' && g.projection.kind !== 'reached' && (
          <>
            <dt className="text-muted-foreground">预计达成</dt>
            <dd className="text-right">
              <ProjectionText projection={g.projection} />
            </dd>
          </>
        )}
      </dl>

      {g.spend && <SpendBlock spend={g.spend} linked={g.linked} />}

      <div className="mt-auto flex flex-wrap items-center gap-3 border-t pt-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <PinSwitch goal={g} />
          固定到首页
        </label>
        {/* R25.9：挂交易不自动完成，提示一下 */}
        {g.kind === 'spend' && g.linked.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-muted-foreground">买完了吗？</span>
            <Button size="sm" onClick={() => onAction({ name: 'complete', goal: g })}>
              <CheckCircle2 />
              完成
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

// R25.3：已存 / 目标 + 进度条；没有进度时换成原因
export function ProgressBlock({ progress: p }: { progress: GoalProgress }) {
  if (p.filledCents === null || p.targetCents === null) {
    return (
      <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
        {p.noProgress ? NO_PROGRESS_LABELS[p.noProgress] : '没有进度'}
      </p>
    );
  }
  // 条宽卡在 0–100%，整数算
  const width = p.targetCents > 0 ? Math.min(Math.floor((p.filledCents * 100) / p.targetCents), 100) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xl font-semibold tabular-nums">{formatAud(p.filledCents)}</span>
        <span className="text-sm text-muted-foreground tabular-nums">
          / {formatAud(p.targetCents)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
      </div>
      {p.reached && <p className="text-xs text-emerald-700 dark:text-emerald-400">已存够</p>}
    </div>
  );
}

// R25.2：已存够 / 已过期 / 没有日期 / 每月 $X
function MonthlyRequired({ goal: g }: { goal: ActiveGoal }) {
  if (g.progress.reached) return <span className="text-muted-foreground">已存够</span>;
  if (g.overdue) {
    return (
      <span className="text-amber-700 dark:text-amber-400">
        已过期，还差{' '}
        <span className="tabular-nums">{formatAud(g.progress.remainingCents ?? 0)}</span>
        ，日期往后推
      </span>
    );
  }
  if (g.monthlyRequiredCents === null) return <span className="text-muted-foreground">没有日期</span>;
  return <span className="tabular-nums">{formatAud(g.monthlyRequiredCents)}</span>;
}

// R25.4：显示到月，晚了标红
function ProjectionText({ projection: p }: { projection: Projection }) {
  switch (p.kind) {
    case 'no_data':
      return <span className="text-muted-foreground">数据不够，估不出来</span>;
    case 'unreachable':
      return <span className="text-destructive">按现在的速度达不到</span>;
    case 'projected':
      return (
        <span>
          预计 <span className="tabular-nums">{p.month}</span>
          {p.lateMonths !== null && p.lateMonths > 0 && (
            <span className="block text-xs text-destructive">
              比目标晚 <span className="tabular-nums">{p.lateMonths}</span> 个月
            </span>
          )}
        </span>
      );
    default:
      return null;
  }
}

// R25.7：计划、实际、差多少；"挂了 N 笔"点开列交易，点交易进交易详情
function SpendBlock({ spend, linked }: { spend: GoalSpend; linked: LinkedSplit[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-t pt-3 text-sm">
      <div className="grid grid-cols-3 gap-2">
        <Figure label="计划" cents={spend.planCents} />
        <Figure label="实际" cents={spend.actualCents} />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-muted-foreground">差多少</span>
          <DiffText spend={spend} />
        </div>
      </div>
      {linked.length === 0 ? (
        <p className="text-xs text-muted-foreground">还没挂交易，在交易详情里挂到这个目标</p>
      ) : (
        <>
          <button
            type="button"
            className="flex items-center gap-1 self-start text-xs text-primary underline-offset-4 hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            挂了 <span className="tabular-nums">{linked.length}</span> 笔
            {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
          {open && <LinkedList linked={linked} />}
        </>
      )}
    </div>
  );
}

export function LinkedList({ linked }: { linked: LinkedSplit[] }) {
  return (
    <ul className="flex flex-col divide-y rounded-md border text-xs">
      {linked.map((s) => (
        <li key={s.splitId}>
          <Link
            href={`/transactions/${s.transactionId}`}
            className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50"
          >
            <span className="shrink-0 text-muted-foreground tabular-nums">{s.date}</span>
            <span className="min-w-0 flex-1 truncate">{s.merchant}</span>
            <span className="shrink-0 tabular-nums">{formatAud(s.amountCents)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Figure({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate tabular-nums">{formatAud(cents)}</span>
    </div>
  );
}

// R25.7：实际 − 计划，> 0 多了，< 0 少了
export function DiffText({ spend }: { spend: GoalSpend }) {
  const d = spend.diffCents;
  if (d === 0) return <span className="text-muted-foreground">刚好</span>;
  return (
    <span className={cn('truncate tabular-nums', d > 0 && 'text-amber-700 dark:text-amber-400')}>
      {d > 0 ? '多了' : '少了'} {formatAud(Math.abs(d))}
    </span>
  );
}

// R25.9：和相邻的 active 目标交换优先级，第一个不能上移，最后一个不能下移
function MoveButtons({
  goal,
  isFirst,
  isLast,
}: {
  goal: ActiveGoal;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const move = (direction: 'up' | 'down') =>
    startTransition(async () => {
      const r = await moveGoalAction(goal.id, direction);
      if (!r.ok) toast.error(r.message);
    });
  return (
    <div className="flex shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={`把 ${goal.name} 上移`}
        disabled={pending || isFirst}
        onClick={() => move('up')}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={`把 ${goal.name} 下移`}
        disabled={pending || isLast}
        onClick={() => move('down')}
      >
        <ChevronDown />
      </Button>
    </div>
  );
}

// 直接保存；成功后 revalidatePath 刷新，开关跟着服务端的值
export function PinSwitch({ goal }: { goal: GoalRecord }) {
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      checked={goal.isPinned}
      disabled={pending}
      aria-label={`把 ${goal.name} 固定到首页`}
      onCheckedChange={(checked) =>
        startTransition(async () => {
          const r = await updateGoalAction(goal.id, { ...goalInput(goal), isPinned: checked });
          if (!r.ok) toast.error(r.message);
        })
      }
    />
  );
}

// 编辑、完成（不是应急金都能完成，R25.9）、删除（挂了交易的不能删）
export function GoalMenu({
  goal,
  onAction,
}: {
  goal: ActiveGoal;
  onAction: (a: GoalAction) => void;
}) {
  const linked = goal.linked.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={`${goal.name} 的操作`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAction({ name: 'edit', goal })}>
          <Pencil />
          编辑
        </DropdownMenuItem>
        {!goal.isEmergency && (
          <DropdownMenuItem onSelect={() => onAction({ name: 'complete', goal })}>
            <CheckCircle2 />
            完成
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          variant="destructive"
          disabled={linked}
          onSelect={() => onAction({ name: 'delete', goal })}
        >
          <Trash2 />
          删除
        </DropdownMenuItem>
        {linked && (
          <DropdownMenuLabel className="max-w-56 text-xs font-normal text-muted-foreground">
            {DELETE_BLOCKED}
          </DropdownMenuLabel>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
