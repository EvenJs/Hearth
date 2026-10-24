'use client';

// R15.2 拆出一部分、R15.3 改拆分（设计图 04-transaction-detail-split）
// 两种用法共用一个表单：金额（正数）、分类、归属人、备注
// - 拆出：归属人默认"自动"，不选就按 R5 算（分类默认 > 卡号 > 账户）
// - 改：只把变了的字段传给服务端，一次提交，任何一项不通过整体不改（R15.3）
//   主拆分不能改金额；auto / confirmed 转账的分类只读（R16.2）
// 金额的提示（主拆分剩余、上限）只是界面上的，真正的校验在服务端
import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatAud } from '@/lib/rules/money';
import { isCategoryLocked, type CategoryOption } from '@/lib/transactions/inline-edit';
import {
  centsToAmountInput,
  parseSplitAmountInput,
  splitAmountPreview,
} from '@/lib/transactions/split-form';
import { cn } from '@/lib/utils';
import type { SplitView, TransactionDetail } from '@/server/transactions';
import { addSplitAction, updateSplitAction } from '../actions';
import { CategoryPicker, pickerLabel } from '../category-picker';
import { categoryLabel } from '../format';
import type { EditOptions } from '../inline-edit';

const AUTO_MEMBER = '__auto__';

type Values = { amount: string; categoryId: string; memberId: string; note: string };

// 保存成功后告诉父组件，主拆分的分类改了要按 R16.9 弹"存成规则"
export type SplitSaved = { categoryChanged: CategoryOption | null; isPrimary: boolean };

type Props = {
  tx: Pick<TransactionDetail, 'id' | 'transferStatus'>;
  primary: SplitView;
  target: SplitView | null; // null = 拆出一部分
  options: EditOptions;
  onClose: () => void;
  onSaved: (r: SplitSaved) => void;
};

function findOption(options: EditOptions, id: string): CategoryOption | undefined {
  for (const g of options.categoryGroups) {
    const o = g.options.find((x) => x.id === id);
    if (o) return o;
  }
  return undefined;
}

// amountRule 为 null 时不改金额（改主拆分）
function makeSchema(amountRule: { primaryCents: number; currentCents: number } | null) {
  return z
    .object({
      amount: z.string(),
      categoryId: z.string().min(1, '请选分类'),
      memberId: z.string().min(1),
      note: z.string(),
    })
    .superRefine((v, ctx) => {
      if (v.note.trim().length > 200) {
        ctx.addIssue({ code: 'custom', path: ['note'], message: '备注最长 200 字' });
      }
      if (!amountRule) return;
      const p = parseSplitAmountInput(v.amount);
      if (!p.ok) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: p.message });
        return;
      }
      const preview = splitAmountPreview({ ...amountRule, inputCents: p.cents });
      if (!preview.ok) {
        ctx.addIssue({
          code: 'custom',
          path: ['amount'],
          message: `必须小于 ${formatAud(preview.limitCents)}（主拆分不能变成 0）`,
        });
      }
    });
}

// 父组件只在打开时挂载它，关掉就卸载，所以每次打开都是新表单
export function SplitDialog({ tx, primary, target, options, onClose, onSaved }: Props) {
  const isAdd = target === null;
  const editingPrimary = target?.isPrimary === true;
  const amountRule = editingPrimary
    ? null
    : { primaryCents: primary.amountCents, currentCents: target?.amountCents ?? 0 };
  const categoryLocked = !isAdd && isCategoryLocked(tx.transferStatus);

  const form = useForm<Values>({
    resolver: zodResolver(makeSchema(amountRule)),
    defaultValues: target
      ? {
          amount: centsToAmountInput(target.amountCents),
          categoryId: target.category.id,
          memberId: target.member.id,
          note: target.note ?? '',
        }
      : { amount: '', categoryId: '', memberId: AUTO_MEMBER, note: '' },
  });

  const amountInput = useWatch({ control: form.control, name: 'amount' });
  const parsedAmount = parseSplitAmountInput(amountInput);
  const preview = amountRule
    ? splitAmountPreview({ ...amountRule, inputCents: parsedAmount.ok ? parsedAmount.cents : null })
    : null;

  async function onSubmit(v: Values) {
    const note = v.note.trim();
    const amountCents = amountRule
      ? (parseSplitAmountInput(v.amount) as { cents: number }).cents
      : 0;

    if (isAdd) {
      const r = await addSplitAction({
        transactionId: tx.id,
        amountCents,
        categoryId: v.categoryId,
        memberId: v.memberId === AUTO_MEMBER ? null : v.memberId,
        note: note || null,
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`已拆出 ${formatAud(Math.sign(primary.amountCents) * amountCents)}`);
      onSaved({ categoryChanged: null, isPrimary: false });
      return;
    }

    // 只传变了的
    const change: {
      amountCents?: number;
      categoryId?: string;
      memberId?: string;
      note?: string | null;
    } = {};
    if (amountRule && amountCents !== Math.abs(target.amountCents))
      change.amountCents = amountCents;
    if (!categoryLocked && v.categoryId !== target.category.id) change.categoryId = v.categoryId;
    if (v.memberId !== target.member.id) change.memberId = v.memberId;
    if (note !== (target.note ?? '')) change.note = note || null;
    if (Object.keys(change).length === 0) {
      onClose();
      return;
    }

    const r = await updateSplitAction({ splitId: target.id, ...change });
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success('拆分已保存');
    onSaved({
      categoryChanged: change.categoryId ? (findOption(options, change.categoryId) ?? null) : null,
      isPrimary: target.isPrimary,
    });
  }

  const submitting = form.formState.isSubmitting;
  const memberListed = target ? options.members.some((m) => m.id === target.member.id) : true;

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isAdd ? '拆出一部分' : editingPrimary ? '修改主拆分' : '修改拆分'}
          </DialogTitle>
          <DialogDescription>
            {isAdd
              ? '从主拆分里分出一部分商品，记到别的分类或归属人。'
              : editingPrimary
                ? '主拆分的金额随其他拆分自动变化，这里只能改分类、归属人和备注。'
                : '改金额时，差额从主拆分补或扣。'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
            {amountRule ? (
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>金额</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                          $
                        </span>
                        <Input
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="15.00"
                          autoFocus={isAdd}
                          className="pl-6 tabular-nums"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    {preview && (
                      <FormDescription
                        className={cn(
                          'flex flex-wrap justify-between gap-x-3 tabular-nums',
                          parsedAmount.ok && !preview.ok && 'text-destructive',
                        )}
                      >
                        <span>
                          主拆分{parsedAmount.ok && preview.ok ? '剩余' : '现在'}{' '}
                          {formatAud(preview.ok ? preview.remainingCents : primary.amountCents)}
                        </span>
                        <span>必须小于 {formatAud(preview.limitCents)}</span>
                      </FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <div className="flex flex-col gap-1 text-sm">
                <span className="font-medium">金额</span>
                <span className="tabular-nums">{formatAud(target!.amountCents)}</span>
              </div>
            )}

            <FormField
              control={form.control}
              name="categoryId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>分类</FormLabel>
                  <CategoryPicker
                    sections={options.categorySections}
                    value={field.value || null}
                    onSelect={(id) => id && field.onChange(id)}
                    mode="edit"
                    disabled={categoryLocked}
                  >
                    <FormControl>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full justify-between px-3 font-normal"
                      >
                        <span className="truncate">
                          {pickerLabel(options.categorySections, field.value) ??
                            (target && field.value === target.category.id
                              ? categoryLabel(target.category)
                              : '选分类')}
                        </span>
                        <ChevronDown className="size-4 opacity-50" />
                      </Button>
                    </FormControl>
                  </CategoryPicker>
                  {categoryLocked && (
                    <FormDescription>内部转账的分类不能改（R16.2）</FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="memberId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>归属人</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent position="popper">
                      {isAdd && (
                        <SelectItem value={AUTO_MEMBER}>自动（按分类、卡号、账户）</SelectItem>
                      )}
                      {target && !memberListed && (
                        <SelectItem value={target.member.id} disabled>
                          {target.member.name}
                        </SelectItem>
                      )}
                      {options.members.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!isAdd && (
                    <FormDescription>
                      只改分类时，归属人会按新分类重新算（手动指定的除外）
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    备注 <span className="font-normal text-muted-foreground">（选填）</span>
                  </FormLabel>
                  <FormControl>
                    <Input autoComplete="off" placeholder="比如：洗发水" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                {isAdd ? '拆分' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
