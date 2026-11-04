'use client';

// /goals 页（R25.11）：顶部每月要存合计和存不存得过来（R25.5）、应急金卡片、active 目标按优先级、折叠的"已完成"
// 新建、编辑、完成、删除走对话框（goal-dialog.tsx）；上下移动、固定开关、撤销完成直接保存
import { ChevronDown, ChevronUp, Plus, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { useLayoutEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatAud } from '@/lib/rules/money';
import { todayInMelbourne } from '@/lib/rules/periods';
import type { DoneGoal, GoalsOverview } from '@/server/goals';
import { reopenGoalAction } from './actions';
import { EmergencyCard } from './emergency-card';
import { DELETE_BLOCKED, DiffText, GoalCard, type GoalAction } from './goal-card';
import { CompleteGoalDialog, DeleteGoalDialog, GoalDialog } from './goal-dialog';

export type AccountOption = { id: string; name: string };

type Props = {
  overview: GoalsOverview;
  accounts: AccountOption[]; // 没归档、不是现金的账户（R25.1）
};

type DialogState = GoalAction | { name: 'create'; emergency: boolean };

export function GoalsView({ overview, accounts }: Props) {
  const [dialog, setDialog] = useState<DialogState | null>(null);

  // 对话框是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(() => () => setDialog(null), []);

  const { emergency, active, done } = overview;
  const close = () => setDialog(null);

  return (
    <>
      <Summary affordability={overview.affordability} />

      <EmergencyCard
        goal={emergency}
        onCreate={() => setDialog({ name: 'create', emergency: true })}
        onAction={setDialog}
      />

      <section aria-label="目标" className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">目标</h2>
          <span className="text-sm text-muted-foreground">按优先级，同一账户先填前面的</span>
          <Button className="ml-auto" onClick={() => setDialog({ name: 'create', emergency: false })}>
            <Plus />
            新建目标
          </Button>
        </div>
        {active.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            还没有目标
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 lg:gap-4">
            {active.map((g, i) => (
              <GoalCard
                key={g.id}
                goal={g}
                isFirst={i === 0}
                isLast={i === active.length - 1}
                onAction={setDialog}
              />
            ))}
          </div>
        )}
      </section>

      {done.length > 0 && <DoneSection done={done} onDelete={(goal) => setDialog({ name: 'delete', goal })} />}

      {(dialog?.name === 'create' || dialog?.name === 'edit') && (
        <GoalDialog
          key={dialog.name === 'edit' ? dialog.goal.id : `create-${dialog.emergency}`}
          goal={dialog.name === 'edit' ? dialog.goal : null}
          isEmergency={dialog.name === 'edit' ? dialog.goal.isEmergency : dialog.emergency}
          accounts={accounts}
          onClose={close}
          onSaved={(msg) => {
            close();
            toast.success(msg);
          }}
        />
      )}
      {dialog?.name === 'complete' && (
        <CompleteGoalDialog
          goal={dialog.goal}
          onClose={close}
          onDone={(msg) => {
            close();
            toast.success(msg);
          }}
        />
      )}
      {dialog?.name === 'delete' && (
        <DeleteGoalDialog
          goal={dialog.goal}
          onClose={close}
          onDeleted={() => {
            close();
            toast.success('目标已删除');
          }}
        />
      )}
    </>
  );
}

// R25.5：每月要存合计、近 3 个月实际每月存下、存不过来的提示
function Summary({ affordability: a }: { affordability: GoalsOverview['affordability'] }) {
  return (
    <Card className="grid gap-6 p-4 md:grid-cols-[repeat(2,minmax(0,1fr))_minmax(0,2fr)] md:p-6">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">每月要存合计</p>
        <p className="text-2xl font-semibold tabular-nums">{formatAud(a.requiredTotalCents)}</p>
        <p className="text-xs text-muted-foreground">有日期、没过期的目标</p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">近 3 个月实际每月存下</p>
        {a.actualCents === null ? (
          <>
            <p className="text-2xl font-semibold">—</p>
            <p className="text-xs text-muted-foreground">还没有完整月的数据</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-semibold tabular-nums">{formatAud(a.actualCents)}</p>
            <p className="text-xs text-muted-foreground">
              基于 <span className="tabular-nums">{a.months}</span> 个月，收入 − 支出
            </p>
          </>
        )}
      </div>
      {a.short && a.actualCents !== null && (
        <p
          role="status"
          className="flex items-start gap-2 self-center rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            目标每月要存 <span className="tabular-nums">{formatAud(a.requiredTotalCents)}</span>
            ，近 3 个月平均只存下 <span className="tabular-nums">{formatAud(a.actualCents)}</span>
            ，目标太多，或者日期往后推
          </span>
        </p>
      )}
    </Card>
  );
}

// R25.11：折叠的"已完成"，按完成日期从新到旧（getGoals 排好了）。电脑上表格，手机上卡片
function DoneSection({ done, onDelete }: { done: DoneGoal[]; onDelete: (g: DoneGoal) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="已完成" className="flex flex-col gap-3">
      <button
        type="button"
        className="flex items-center gap-2 self-start text-lg font-semibold"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        已完成
        <span className="text-sm font-normal text-muted-foreground tabular-nums">{done.length}</span>
        {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </button>
      {open && (
        <>
          <div className="hidden rounded-lg border md:block">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>名字</TableHead>
                  <TableHead className="w-32 text-right">计划</TableHead>
                  <TableHead className="w-32 text-right">实际</TableHead>
                  <TableHead className="w-36 text-right">差多少</TableHead>
                  <TableHead className="w-28">完成日期</TableHead>
                  <TableHead className="w-44">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {done.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="truncate font-medium">{g.name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAud(g.spend.planCents)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAud(g.spend.actualCents)}
                    </TableCell>
                    <TableCell className="text-right">
                      <DiffText spend={g.spend} />
                    </TableCell>
                    <TableCell className="tabular-nums">{doneDate(g)}</TableCell>
                    <TableCell>
                      <DoneActions goal={g} onDelete={onDelete} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="flex flex-col gap-2 md:hidden">
            {done.map((g) => (
              <li key={g.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate font-medium">{g.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {doneDate(g)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>
                    计划 <span className="tabular-nums">{formatAud(g.spend.planCents)}</span>
                  </span>
                  <span>
                    实际 <span className="tabular-nums">{formatAud(g.spend.actualCents)}</span>
                  </span>
                  <DiffText spend={g.spend} />
                </div>
                <DoneActions goal={g} onDelete={onDelete} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// done_at 按 Melbourne 显示日期
function doneDate(g: DoneGoal): string {
  return g.doneAt === null ? '—' : todayInMelbourne(new Date(g.doneAt));
}

// R25.9：撤销完成直接保存，报错（重名、下一期挂了交易）用 toast；挂了交易的不能删
function DoneActions({ goal, onDelete }: { goal: DoneGoal; onDelete: (g: DoneGoal) => void }) {
  const [pending, startTransition] = useTransition();
  const linked = goal.linked.length > 0;
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await reopenGoalAction(goal.id);
            if (r.ok) toast.success('已撤销完成');
            else toast.error(r.message);
          })
        }
      >
        <RotateCcw />
        撤销完成
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={linked}
        title={linked ? DELETE_BLOCKED : undefined}
        aria-label={`删除 ${goal.name}`}
        onClick={() => onDelete(goal)}
      >
        <Trash2 />
      </Button>
    </div>
  );
}
