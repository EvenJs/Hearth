'use client';

// F10 拆分（R15、R16.1）：每个拆分一行，金额、分类、归属人（带 member_source 说明）、备注
// 拆出一部分、改拆分用同一个对话框（split-dialog.tsx），删除非主拆分先确认
// 主拆分改了分类按 R16.9 弹"存成规则"（和列表一致）；子拆分不弹
// R22.1 支出拆分一个"一次性"勾选；R22.3 大额未标时上面一行提示，带"是""不是一次性"
// R25.7 支出拆分一个"挂到目标"下拉（goal-select.tsx），在一次性旁边
// 电脑（lg 以上）是表格，窄屏是卡片
import { Loader2, Pencil, Plus, Split, Trash2 } from 'lucide-react';
import { useLayoutEffect, useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatAud } from '@/lib/rules/money';
import { canMarkOneOff } from '@/lib/rules/one-off';
import { isCategoryLocked } from '@/lib/transactions/inline-edit';
import { memberSourceLabel } from '@/lib/transactions/split-form';
import { cn } from '@/lib/utils';
import type { SplitView, TransactionDetail } from '@/server/transactions';
import { removeSplitAction } from '../actions';
import { answerOneOffHintAction, setSplitOneOffAction } from './actions';
import { offerRuleAfterChange, type EditOptions, type RuleDraft } from '../inline-edit';
import { SaveRuleDialog } from '../save-rule-dialog';
import { CategoryTag } from '../tx-badges';
import { GoalSelect, type LinkableGoal } from './goal-select';
import { SplitDialog, type SplitSaved } from './split-dialog';

type DialogState = { mode: 'add' } | { mode: 'edit'; split: SplitView } | null;

export function SplitSection({
  tx,
  options,
  goals,
}: {
  tx: TransactionDetail;
  options: EditOptions;
  goals: readonly LinkableGoal[];
}) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [removing, setRemoving] = useState<SplitView | null>(null);
  const [ruleDraft, setRuleDraft] = useState<{ key: number; draft: RuleDraft } | null>(null);

  // 对话框是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(
    () => () => {
      setDialog(null);
      setRemoving(null);
      setRuleDraft(null);
    },
    [],
  );

  const primary = tx.splits.find((s) => s.isPrimary);
  if (!primary) return null; // R15.1 保证有，防御一下
  const isSplit = tx.splits.length > 1;
  // R15.2 补充：auto / confirmed 转账不能拆分
  const canAdd = !isCategoryLocked(tx.transferStatus);
  // R22.1：收入、转账、未分类的交易整列不显示
  const markable = tx.splits.some((s) => canMarkOneOff(s.category));

  const offerRule = (draft: RuleDraft) =>
    setRuleDraft((prev) => ({ key: (prev?.key ?? 0) + 1, draft }));

  // R16.9：改了分类才问；详情页不做 R16.10 归属人联动
  function onSaved(r: SplitSaved) {
    setDialog(null);
    const c = r.categoryChanged;
    if (!c) return;
    void offerRuleAfterChange(
      { transactionId: tx.id, isPrimary: r.isPrimary, kind: c.kind },
      { merchant: tx.merchant, categoryId: c.id, categoryLabel: c.label },
      offerRule,
    );
  }

  const rowActions = (s: SplitView) => ({
    onEdit: () => setDialog({ mode: 'edit', split: s }),
    onRemove: s.isPrimary ? undefined : () => setRemoving(s),
  });

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Split className="size-4" />
          拆分
          {isSplit && (
            <Badge variant="secondary" className="font-normal">
              {tx.splits.length} 项
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {canAdd
            ? '一笔交易像一张小票，可以把一部分商品分到别的分类或归属人。'
            : '内部转账不能拆分，分类也不能改，只能改归属人。'}
          {canAdd && tx.transferStatus === 'suggested' && ' 建议转账拆分以后就不能确认成转账了。'}
        </CardDescription>
        {canAdd && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => setDialog({ mode: 'add' })}>
              <Plus />
              拆出一部分
            </Button>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {tx.oneOffHint && <OneOffHint transactionId={tx.id} />}

        {/* 电脑：表格 */}
        <div className="hidden rounded-lg border lg:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4 text-right">金额</TableHead>
                <TableHead>分类</TableHead>
                <TableHead>归属人</TableHead>
                <TableHead>备注</TableHead>
                {markable && <TableHead className="w-16">一次性</TableHead>}
                {markable && <TableHead className="w-52">目标</TableHead>}
                <TableHead className="w-24 pr-4 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tx.splits.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4 text-right font-medium">
                    <Amount cents={s.amountCents} />
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <CategoryTag category={s.category} />
                      {s.isPrimary && isSplit && <PrimaryBadge />}
                    </span>
                  </TableCell>
                  <TableCell>
                    <MemberCell split={s} cardLast4={tx.cardLast4} />
                  </TableCell>
                  <TableCell
                    className="max-w-64 truncate text-muted-foreground"
                    title={s.note ?? undefined}
                  >
                    {s.note ?? '—'}
                  </TableCell>
                  {markable && (
                    <TableCell>
                      {canMarkOneOff(s.category) && <OneOffCheckbox split={s} />}
                    </TableCell>
                  )}
                  {markable && (
                    <TableCell className="max-w-52 whitespace-normal">
                      {canMarkOneOff(s.category) && <GoalSelect split={s} goals={goals} />}
                    </TableCell>
                  )}
                  <TableCell className="pr-4 text-right">
                    <RowButtons {...rowActions(s)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            {isSplit && (
              <TableFooter>
                <TableRow>
                  <TableCell className="pl-4 text-right font-medium">
                    <Amount cents={sumOf(tx.splits)} />
                  </TableCell>
                  <TableCell colSpan={markable ? 6 : 4} className="text-muted-foreground">
                    拆分合计 = 交易金额 {formatAud(tx.amountCents)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>

        {/* 窄屏：卡片 */}
        <ul className="flex flex-col gap-2 lg:hidden">
          {tx.splits.map((s) => (
            <li key={s.id} className="flex flex-col gap-1.5 rounded-lg border p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <CategoryTag category={s.category} />
                  {s.isPrimary && isSplit && <PrimaryBadge />}
                </span>
                <Amount cents={s.amountCents} className="shrink-0 font-medium" />
              </div>
              <div className="flex items-end justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <MemberCell split={s} cardLast4={tx.cardLast4} />
                  {s.note && <span className="break-words text-muted-foreground">{s.note}</span>}
                  {canMarkOneOff(s.category) && <OneOffCheckbox split={s} withLabel />}
                </div>
                <RowButtons {...rowActions(s)} />
              </div>
              {canMarkOneOff(s.category) && <GoalSelect split={s} goals={goals} />}
            </li>
          ))}
          {isSplit && (
            <li className="flex justify-between gap-3 px-1 text-sm text-muted-foreground">
              <span>拆分合计 = 交易金额</span>
              <Amount cents={sumOf(tx.splits)} className="font-medium text-foreground" />
            </li>
          )}
        </ul>
      </CardContent>

      {dialog && (
        <SplitDialog
          tx={tx}
          primary={primary}
          target={dialog.mode === 'edit' ? dialog.split : null}
          options={options}
          onClose={() => setDialog(null)}
          onSaved={onSaved}
        />
      )}

      {removing && <RemoveSplitDialog split={removing} onClose={() => setRemoving(null)} />}

      {ruleDraft && (
        <SaveRuleDialog
          key={ruleDraft.key}
          draft={ruleDraft.draft}
          onClose={() => setRuleDraft(null)}
        />
      )}
    </Card>
  );
}

function sumOf(splits: readonly SplitView[]): number {
  return splits.reduce((s, x) => s + x.amountCents, 0);
}

function Amount({ cents, className }: { cents: number; className?: string }) {
  return (
    <span className={cn('tabular-nums', cents > 0 && 'text-green-700', className)}>
      {cents > 0 ? '+' : ''}
      {formatAud(cents)}
    </span>
  );
}

function PrimaryBadge() {
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      主拆分
    </Badge>
  );
}

// R5：归属人 + 是按哪一条定的
function MemberCell({ split, cardLast4 }: { split: SplitView; cardLast4: string | null }) {
  return (
    <span>
      {split.member.name}
      <span className="ml-1.5 text-xs text-muted-foreground">
        {memberSourceLabel(split.memberSource, cardLast4)}
      </span>
    </span>
  );
}

// R22.1：勾上 = true，取消 = false（看过了，不是）。null 显示成没勾
// 保存期间先显示新值，失败了回到原来的
function OneOffCheckbox({ split, withLabel }: { split: SplitView; withLabel?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useOptimistic(split.isOneOff === true);

  function change(value: boolean) {
    startTransition(async () => {
      setChecked(value);
      const r = await setSplitOneOffAction({ splitId: split.id, value });
      if (!r.ok) toast.error(r.message);
    });
  }

  const box = (
    <Checkbox
      checked={checked}
      disabled={pending}
      aria-label={withLabel ? undefined : '一次性'}
      onCheckedChange={(v) => change(v === true)}
    />
  );
  if (!withLabel) return box;
  return (
    <label className="flex w-fit items-center gap-1.5 text-muted-foreground">
      {box}
      一次性
    </label>
  );
}

// R22.3：大额未标。"是"/"不是一次性"把这笔所有 null 的支出拆分设成 true / false，刷新后提示消失
function OneOffHint({ transactionId }: { transactionId: string }) {
  const [pending, startTransition] = useTransition();
  const [answering, setAnswering] = useState<boolean | null>(null);

  function answer(value: boolean) {
    setAnswering(value);
    startTransition(async () => {
      const r = await answerOneOffHintAction({ transactionId, value });
      if (!r.ok) toast.error(r.message);
      else toast.success(value ? '已标成一次性' : '已标成不是一次性');
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      <span>这笔是一次性开销吗？</span>
      <span className="flex gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => answer(true)}>
          {pending && answering === true && <Loader2 className="animate-spin" />}是
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => answer(false)}>
          {pending && answering === false && <Loader2 className="animate-spin" />}
          不是一次性
        </Button>
      </span>
    </div>
  );
}

function RowButtons({ onEdit, onRemove }: { onEdit: () => void; onRemove?: () => void }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <Button variant="ghost" size="icon-sm" aria-label="修改拆分" title="修改" onClick={onEdit}>
        <Pencil />
      </Button>
      {onRemove ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="删除拆分"
          title="删除"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      ) : (
        // 主拆分不能删除，占个位让两列对齐
        <span className="inline-block size-8" aria-hidden />
      )}
    </span>
  );
}

// R15.3 删除非主拆分：金额全部加回主拆分
function RemoveSplitDialog({ split, onClose }: { split: SplitView; onClose: () => void }) {
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const r = await removeSplitAction({ splitId: split.id });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success('拆分已删除，金额加回主拆分');
      onClose();
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这个拆分？</AlertDialogTitle>
          <AlertDialogDescription>
            {split.category.nameEn} {formatAud(split.amountCents)} 会全部加回主拆分。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(e) => {
              e.preventDefault(); // 等删完再关
              confirm();
            }}
          >
            {pending && <Loader2 className="animate-spin" />}
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
