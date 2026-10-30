'use client';

// 设置 → 预算（设计图 10，R11、R11.1、R11.3）。电脑上表格，手机上卡片（10-settings-budgets-mobile）
// 顶部是 R11.1 的总览；被一级包含的二级预算照常显示进度，标"不进合计"
// 固定开关直接保存；新建、修改、删除走对话框（budget-dialog.tsx）
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useLayoutEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { BudgetOverview } from '@/lib/rules/budget';
import { formatAud } from '@/lib/rules/money';
import type { BudgetLevel } from '@/lib/rules/stats';
import type { PickerSections } from '@/lib/transactions/category-picker';
import { cn } from '@/lib/utils';
import type { BudgetItem } from '@/server/budgets';
import type { CategoryRef } from '@/server/transactions';
import { transactionsHref } from '../../transactions/href';
import { CategoryTag } from '../../transactions/tx-badges';
import { setBudgetPinnedAction } from './actions';
import { BudgetDialog, DeleteBudgetDialog } from './budget-dialog';

export type CategoryRefMap = Record<string, CategoryRef>;

type Props = {
  budgets: BudgetItem[]; // 已经按分类顺序排好
  overview: BudgetOverview;
  refs: CategoryRefMap;
  sections: PickerSections; // 新建时的分类下拉（R11.2）
};

type Dialog =
  | { name: 'create' }
  | { name: 'edit'; budget: BudgetItem }
  | { name: 'delete'; budget: BudgetItem };

// R11：ok 正常色、warn 琥珀色、over 红色
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

export function BudgetsView({ budgets, overview, refs, sections }: Props) {
  const [dialog, setDialog] = useState<Dialog | null>(null);

  // 对话框是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(() => () => setDialog(null), []);

  const nameOf = (id: string) => refs[id]?.nameEn ?? '（分类已删除）';

  return (
    <>
      {budgets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          还没有预算
          <Button onClick={() => setDialog({ name: 'create' })}>
            <Plus />
            新建预算
          </Button>
        </div>
      ) : (
        <>
          <Overview overview={overview} />

          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">预算列表</h2>
            <span className="text-sm text-muted-foreground">共 {budgets.length} 个</span>
            <Button className="ml-auto" onClick={() => setDialog({ name: 'create' })}>
              <Plus />
              新建预算
            </Button>
          </div>

          {/* 电脑：表格 */}
          <div className="hidden rounded-lg border md:block">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-64">分类</TableHead>
                  <TableHead className="w-52 text-right">已花 / 上限</TableHead>
                  <TableHead>进度</TableHead>
                  <TableHead className="w-24 text-center">固定到首页</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {budgets.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <BudgetCategory budget={b} refs={refs} nameOf={nameOf} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amounts budget={b} />
                    </TableCell>
                    <TableCell>
                      <Progress budget={b} />
                    </TableCell>
                    <TableCell className="text-center">
                      <PinSwitch budget={b} />
                    </TableCell>
                    <TableCell>
                      <RowMenu budget={b} onAction={setDialog} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* 手机：卡片 */}
          <ul className="flex flex-col gap-2 md:hidden">
            {budgets.map((b) => (
              <li key={b.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <BudgetCategory budget={b} refs={refs} nameOf={nameOf} />
                  </div>
                  <RowMenu budget={b} onAction={setDialog} />
                </div>
                <Amounts budget={b} />
                <Progress budget={b} />
                <label className="flex items-center justify-between text-sm text-muted-foreground">
                  固定到首页
                  <PinSwitch budget={b} />
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      {(dialog?.name === 'create' || dialog?.name === 'edit') && (
        <BudgetDialog
          key={dialog.name === 'edit' ? dialog.budget.id : 'create'}
          budget={dialog.name === 'edit' ? dialog.budget : null}
          sections={sections}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setDialog(null);
            toast.success(msg);
          }}
        />
      )}
      {dialog?.name === 'delete' && (
        <DeleteBudgetDialog
          budget={dialog.budget}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            toast.success('预算已删除');
          }}
        />
      )}
    </>
  );
}

// R11.1：上限合计、已花合计、还剩（可以是负数）、没设预算的分类
function Overview({ overview }: { overview: BudgetOverview }) {
  const { limitCents, spentCents, remainingCents, uncovered } = overview;
  return (
    <Card className="grid gap-6 p-4 md:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.5fr)] md:p-6">
      <Stat label="上限合计" cents={limitCents} />
      <Stat label="已花合计" cents={spentCents} />
      <Stat label="还剩" cents={remainingCents} negativeRed />
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-sm text-muted-foreground">没设预算的分类（本月）</p>
        {uncovered.length === 0 ? (
          <p className="text-sm text-muted-foreground">本月的支出都在预算里</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {uncovered.map((u) => (
              <li key={u.categoryId} className="flex items-center justify-between gap-3">
                {/* "X（其他）"不跳：F8 选一级会带上有预算的二级，笔数对不上 */}
                {u.isOther ? (
                  <span className="truncate">{u.label}</span>
                ) : (
                  <Link
                    href={transactionsHref({ period: 'this_month', categoryId: u.categoryId })}
                    className="truncate underline-offset-4 hover:underline"
                  >
                    {u.label}
                  </Link>
                )}
                <span className="shrink-0 tabular-nums">{formatAud(u.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function Stat({
  label,
  cents,
  negativeRed,
}: {
  label: string;
  cents: number;
  negativeRed?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={cn(
          'text-2xl font-semibold tabular-nums',
          negativeRed && cents < 0 && 'text-destructive',
        )}
      >
        {formatAud(cents)}
      </p>
    </div>
  );
}

function BudgetCategory({
  budget,
  refs,
  nameOf,
}: {
  budget: BudgetItem;
  refs: CategoryRefMap;
  nameOf: (id: string) => string;
}) {
  const ref = refs[budget.categoryId];
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {ref ? (
        <CategoryTag category={ref} />
      ) : (
        <span className="truncate text-sm">{budget.label}</span>
      )}
      {budget.includedIn && (
        <span className="text-xs text-muted-foreground">
          已含在 {nameOf(budget.includedIn)} 里，不进合计
        </span>
      )}
    </div>
  );
}

function Amounts({ budget }: { budget: BudgetItem }) {
  const { spentCents, limitCents } = budget.progress;
  return (
    <span className="text-sm whitespace-nowrap tabular-nums">
      {formatAud(spentCents)}
      <span className="text-muted-foreground"> / {formatAud(limitCents)}</span>
    </span>
  );
}

// 条宽卡在 0–100%（负数是空条），百分比照实显示（180%、-20%）
function Progress({ budget }: { budget: BudgetItem }) {
  const { percent, level } = budget.progress;
  const width = Math.min(Math.max(percent, 0), 100);
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', BAR[level])} style={{ width: `${width}%` }} />
      </div>
      <span className={cn('w-12 text-right text-sm tabular-nums', PERCENT_TEXT[level])}>
        {Math.round(percent)}%
      </span>
    </div>
  );
}

// 直接保存；成功后 revalidatePath 刷新，开关跟着服务端的值
function PinSwitch({ budget }: { budget: BudgetItem }) {
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      checked={budget.isPinned}
      disabled={pending}
      aria-label={`把 ${budget.label} 固定到首页`}
      onCheckedChange={(checked) =>
        startTransition(async () => {
          const r = await setBudgetPinnedAction(budget.id, checked);
          if (!r.ok) toast.error(r.message);
        })
      }
    />
  );
}

function RowMenu({ budget, onAction }: { budget: BudgetItem; onAction: (d: Dialog) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`${budget.label} 的操作`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAction({ name: 'edit', budget })}>
          <Pencil />
          修改
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => onAction({ name: 'delete', budget })}
        >
          <Trash2 />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
