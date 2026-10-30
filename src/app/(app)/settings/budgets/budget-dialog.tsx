'use client';

// 新建 / 修改预算的对话框（设计图 10，R11.2），和删除确认（R11.3）
// 字段：分类（只在新建时能选，R11.2 的范围）、每月上限、提醒百分比（1–100，默认 80）、固定到首页
// 编辑不能改分类，要换就删掉重建。报错（已经有预算、上限不对）显示在对话框里，不关
import { ChevronsUpDown, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { PickerSections } from '@/lib/transactions/category-picker';
import { cn } from '@/lib/utils';
import type { BudgetItem } from '@/server/budgets';
import { CategoryPicker, pickerLabel } from '../../transactions/category-picker';
import { createBudgetAction, deleteBudgetAction, updateBudgetAction } from './actions';

const DEFAULT_WARN = 80;

// 分 → 输入框里的元，20000 → "200.00"。只用整数运算
function centsToInput(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

type Props = {
  budget: BudgetItem | null; // null = 新建
  sections: PickerSections;
  onClose: () => void;
  onSaved: (message: string) => void;
};

export function BudgetDialog({ budget, sections, onClose, onSaved }: Props) {
  const [categoryId, setCategoryId] = useState<string | null>(budget?.categoryId ?? null);
  const [limit, setLimit] = useState(budget ? centsToInput(budget.monthlyLimitCents) : '');
  const [warn, setWarn] = useState(String(budget?.warnAtPercent ?? DEFAULT_WARN));
  const [isPinned, setIsPinned] = useState(budget?.isPinned ?? false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const label = pickerLabel(sections, categoryId);

  function save() {
    if (!budget && !categoryId) {
      setError('请选择分类');
      return;
    }
    const warnAtPercent = Number(warn);
    if (!/^\d+$/.test(warn.trim()) || warnAtPercent < 1 || warnAtPercent > 100) {
      setError('提醒百分比要是 1 到 100 的整数');
      return;
    }
    setError(null);
    startTransition(async () => {
      const input = { monthlyLimit: limit, warnAtPercent, isPinned };
      const r = budget
        ? await updateBudgetAction(budget.id, input)
        : await createBudgetAction({ ...input, categoryId: categoryId! });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      onSaved(budget ? '预算已修改' : '预算已新建');
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{budget ? '修改预算' : '新建预算'}</DialogTitle>
            <DialogDescription>
              按自然月算。一级的预算包含它下面所有二级的支出，退款会冲减。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label id="budget-category">分类</Label>
            {budget ? (
              <>
                <p
                  aria-labelledby="budget-category"
                  className="rounded-md border bg-muted px-3 py-2 text-sm"
                >
                  {budget.label}
                </p>
                <p className="text-xs text-muted-foreground">分类不能改，要换就删掉重建。</p>
              </>
            ) : (
              <CategoryPicker
                sections={sections}
                value={categoryId}
                onSelect={(id) => setCategoryId(id)}
                mode="edit"
              >
                <Button
                  type="button"
                  variant="outline"
                  aria-labelledby="budget-category"
                  className="w-full justify-between font-normal"
                >
                  <span className={cn('truncate', !label && 'text-muted-foreground')}>
                    {label ?? '选择分类'}
                  </span>
                  <ChevronsUpDown className="text-muted-foreground" />
                </Button>
              </CategoryPicker>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="budget-limit">每月上限</Label>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
              <Input
                id="budget-limit"
                inputMode="decimal"
                autoComplete="off"
                placeholder="200.00"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                className="pl-6 tabular-nums"
                autoFocus={budget !== null}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="budget-warn">提醒百分比</Label>
            <div className="relative">
              <Input
                id="budget-warn"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                step={1}
                value={warn}
                onChange={(e) => setWarn(e.target.value)}
                className="pr-8 tabular-nums"
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">
                %
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              本月支出达到上限的这个比例时变琥珀色，超过上限变红。
            </p>
          </div>

          <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <span className="flex flex-col">
              <span className="text-sm font-medium">固定到首页</span>
              <span className="text-xs text-muted-foreground">在看板顶部显示这条进度</span>
            </span>
            <Switch checked={isPinned} onCheckedChange={setIsPinned} />
          </label>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={pending || limit.trim() === ''}>
              {pending && <Loader2 className="animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// R11.3：硬删除，不能恢复。只删预算，不动交易
export function DeleteBudgetDialog({
  budget,
  onClose,
  onDeleted,
}: {
  budget: BudgetItem;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function remove() {
    setError(null);
    startTransition(async () => {
      const r = await deleteBudgetAction(budget.id);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      onDeleted();
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除 {budget.label} 的预算？</AlertDialogTitle>
          <AlertDialogDescription>直接删除，不能恢复。交易不受影响。</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            取消
          </AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={pending} onClick={remove}>
            {pending && <Loader2 className="animate-spin" />}
            删除
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
