'use client';

// 新建 / 编辑目标的对话框（R25.1、R25.11），和完成、删除的确认（R25.9）
// 普通目标：名字、类型、重复（只有要花掉的能选每年）、目标金额、目标日期（每年重复必填）、账户、固定到首页
// 应急金：名字、月数、账户、固定到首页，金额自动算（R25.6）。是不是应急金不能改
// 界面上先校验一次，服务端按 R25.1 的顺序再校验；报错显示在对应字段下面，不关
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
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
import { Switch } from '@/components/ui/switch';
import { parseAmountToCents } from '@/lib/rules/money';
import type { GoalField, GoalInput, GoalRecord } from '@/server/goals';
import {
  completeGoalAction,
  createGoalAction,
  deleteGoalAction,
  updateGoalAction,
} from './actions';
import type { AccountOption } from './goals-view';

// "不挂账户"。Radix Select 的值不能是空字符串
const NO_ACCOUNT = '__none__';
const DEFAULT_MONTHS = 6; // R25.1
const MAX_NAME = 50;

type Values = {
  name: string;
  kind: 'keep' | 'spend';
  recurrence: 'once' | 'yearly';
  target: string; // 元
  targetDate: string; // '' = 没有日期
  accountId: string; // NO_ACCOUNT = 不挂
  months: string;
  isPinned: boolean;
};

// 分 → 输入框里的元，500000 → "5000.00"。只用整数运算
function centsToInput(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// 格式不对、0、负数都是 null
function positiveCents(v: string): number | null {
  try {
    const cents = parseAmountToCents(v.trim());
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

// R25.1 的 1、2、4、6、7 条；重名、账户、应急金唯一在服务端查。第 5 条界面上选不出来
function makeSchema(isEmergency: boolean) {
  return z
    .object({
      name: z.string(),
      kind: z.enum(['keep', 'spend']),
      recurrence: z.enum(['once', 'yearly']),
      target: z.string(),
      targetDate: z.string(),
      accountId: z.string(),
      months: z.string(),
      isPinned: z.boolean(),
    })
    .superRefine((v, ctx) => {
      const name = v.name.trim().replace(/\s+/g, ' ');
      if (name === '') ctx.addIssue({ code: 'custom', path: ['name'], message: '请填名字' });
      else if (name.length > MAX_NAME)
        ctx.addIssue({ code: 'custom', path: ['name'], message: `名字最多 ${MAX_NAME} 个字` });
      if (isEmergency) {
        const n = Number(v.months);
        if (!/^\d+$/.test(v.months.trim()) || n < 1 || n > 24)
          ctx.addIssue({ code: 'custom', path: ['months'], message: '月数是 1 到 24' });
        return;
      }
      if (positiveCents(v.target) === null)
        ctx.addIssue({ code: 'custom', path: ['target'], message: '目标金额要大于 0' });
      if (v.recurrence === 'yearly' && v.targetDate === '')
        ctx.addIssue({ code: 'custom', path: ['targetDate'], message: '每年重复的目标要填日期' });
    });
}

// 服务端的字段 → 表单字段；form 显示在底部
const FIELD_OF: Record<Exclude<GoalField, 'form'>, keyof Values> = {
  name: 'name',
  targetCents: 'target',
  recurrence: 'recurrence',
  targetDate: 'targetDate',
  emergencyMonths: 'months',
  accountId: 'accountId',
};

function defaultsOf(goal: GoalRecord | null, isEmergency: boolean): Values {
  if (goal === null) {
    return {
      name: isEmergency ? '应急金' : '',
      kind: isEmergency ? 'keep' : 'spend',
      recurrence: 'once',
      target: '',
      targetDate: '',
      accountId: NO_ACCOUNT,
      months: String(DEFAULT_MONTHS),
      isPinned: false,
    };
  }
  return {
    name: goal.name,
    kind: goal.kind,
    recurrence: goal.recurrence,
    target: goal.targetCents === null ? '' : centsToInput(goal.targetCents),
    targetDate: goal.targetDate ?? '',
    accountId: goal.account?.id ?? NO_ACCOUNT,
    months: String(goal.emergencyMonths ?? DEFAULT_MONTHS),
    isPinned: goal.isPinned,
  };
}

type Props = {
  goal: GoalRecord | null; // null = 新建
  isEmergency: boolean; // 编辑时看 goal.isEmergency
  accounts: AccountOption[]; // 没归档、不是现金的账户
  onClose: () => void;
  onSaved: (message: string) => void;
};

export function GoalDialog({ goal, isEmergency, accounts, onClose, onSaved }: Props) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(makeSchema(isEmergency)),
    defaultValues: defaultsOf(goal, isEmergency),
  });
  const submitting = form.formState.isSubmitting;
  const kind = form.watch('kind');

  // R25.1：已经挂着、后来归档了的账户留在下拉里，不改就不重新校验
  const options =
    goal?.account && !accounts.some((a) => a.id === goal.account!.id)
      ? [
          ...accounts,
          {
            id: goal.account.id,
            name: `${goal.account.name}${goal.account.isArchived ? '（已归档）' : ''}`,
          },
        ]
      : accounts;

  async function onSubmit(v: Values) {
    setFormError(null);
    const input: GoalInput = {
      name: v.name,
      kind: isEmergency ? 'keep' : v.kind,
      recurrence: isEmergency ? 'once' : v.recurrence,
      targetCents: isEmergency ? null : positiveCents(v.target),
      targetDate: isEmergency || v.targetDate === '' ? null : v.targetDate,
      accountId: v.accountId === NO_ACCOUNT ? null : v.accountId,
      emergencyMonths: isEmergency ? Number(v.months) : null,
      isPinned: v.isPinned,
    };
    const r = goal
      ? await updateGoalAction(goal.id, input)
      : await createGoalAction({ ...input, isEmergency });
    if (!r.ok) {
      if (r.field === 'form') setFormError(r.message);
      else form.setError(FIELD_OF[r.field], { message: r.message });
      return;
    }
    onSaved(goal ? '目标已修改' : '目标已新建');
  }

  const title = isEmergency
    ? goal
      ? '修改应急金'
      : '设一个应急金'
    : goal
      ? '修改目标'
      : '新建目标';

  return (
    <Dialog open onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isEmergency
              ? '目标金额 = 近 12 个月月均 × 月数，月均变了跟着变。永远排第一个，先用账户余额填它。'
              : '挂了账户的目标按顺序用账户余额填进度。'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>名字</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" placeholder="如 日本旅行" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {isEmergency ? (
              <FormField
                control={form.control}
                name="months"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>月数</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={24}
                        step={1}
                        className="w-28 tabular-nums"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>存够几个月的支出，1 到 24</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="kind"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>类型</FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={(v) => {
                            field.onChange(v);
                            // R25.1 第 5 条：只有要花掉的能每年重复
                            if (v === 'keep') form.setValue('recurrence', 'once');
                          }}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="spend">要花掉的</SelectItem>
                            <SelectItem value="keep">存着的</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="recurrence"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>重复</FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={kind === 'keep'}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="once">一次</SelectItem>
                            <SelectItem value="yearly">每年</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <p className="-mt-3 text-xs text-muted-foreground">
                  {kind === 'keep'
                    ? '存着的：钱一直放着，如首付'
                    : '要花掉的：买的时候把交易挂上来，看计划和实际，如包、旅行、rego'}
                </p>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="target"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>目标金额</FormLabel>
                        <div className="relative">
                          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">
                            $
                          </span>
                          <FormControl>
                            <Input
                              inputMode="decimal"
                              autoComplete="off"
                              placeholder="5000.00"
                              className="pl-6 tabular-nums"
                              {...field}
                            />
                          </FormControl>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="targetDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          目标日期{form.watch('recurrence') === 'once' && '（可选）'}
                        </FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </>
            )}

            <FormField
              control={form.control}
              name="accountId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>挂的账户</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NO_ACCOUNT}>不挂账户</SelectItem>
                      {options.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    用这个账户的可用余额填进度。不挂就没有进度，只算每月要存
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isPinned"
              render={({ field }) => (
                <FormItem>
                  <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">固定到首页</span>
                      <span className="text-xs text-muted-foreground">在看板上显示这个目标</span>
                    </span>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </label>
                </FormItem>
              )}
            />

            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                保存
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// R25.9：once 变 done；yearly 同时建下一期。都能撤销
export function CompleteGoalDialog({
  goal,
  onClose,
  onDone,
}: {
  goal: GoalRecord;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const yearly = goal.recurrence === 'yearly';
  return (
    <ConfirmDialog
      title={`完成 ${goal.name}？`}
      description={
        yearly
          ? '这一期变成已完成，同时建下一年的（日期往后一年，金额、账户照抄）。之后可以撤销。'
          : '完成后不再占账户的钱，同一账户后面的目标往前顶。之后可以撤销。'
      }
      confirmLabel="完成"
      onClose={onClose}
      run={() => completeGoalAction(goal.id)}
      onOk={() => onDone(yearly ? '已完成，下一年的已经建好' : '目标已完成')}
    />
  );
}

// R25.9：硬删除，不能恢复。挂了交易的服务端也会拦
export function DeleteGoalDialog({
  goal,
  onClose,
  onDeleted,
}: {
  goal: GoalRecord;
  onClose: () => void;
  onDeleted: () => void;
}) {
  return (
    <ConfirmDialog
      title={`删除目标 ${goal.name}？`}
      description="直接删除，不能恢复。交易不受影响。"
      confirmLabel="删除"
      destructive
      onClose={onClose}
      run={() => deleteGoalAction(goal.id)}
      onOk={onDeleted}
    />
  );
}

// 报错显示在对话框里，不关
function ConfirmDialog({
  title,
  description,
  confirmLabel,
  destructive,
  onClose,
  run,
  onOk,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onClose: () => void;
  run: () => Promise<{ ok: true } | { ok: false; message: string }>;
  onOk: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const r = await run();
      if (!r.ok) {
        setError(r.message);
        return;
      }
      onOk();
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
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
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={confirm}
          >
            {pending && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
