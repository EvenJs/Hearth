'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
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
import {
  CONDITION_OUTCOMES,
  CONDITION_TYPES,
  CONDITION_TYPE_LABELS,
  DEPOSIT_FILTERS,
  DEPOSIT_FILTER_LABELS,
  type ConditionType,
} from '@/lib/rules/conditions';
import { parseAmountToCents } from '@/lib/rules/money';
import { lastTwelveMonths, startOfMonth } from '@/lib/rules/periods';
import type {
  ConditionErrors,
  ConditionParamsInput,
  StoredCondition,
} from '@/server/conditions';
import { createConditionAction, updateConditionAction } from './actions';

const OUTCOME_OPTION_LABELS = { bonus: '拿 bonus', fee_waiver: '免月费' } as const;

const isLinkedType = (type: ConditionType | undefined) =>
  type === 'linked_min_deposit' || type === 'linked_card_count';
const hasAmount = (type: ConditionType | undefined) =>
  type === 'min_deposit' || type === 'linked_min_deposit';

// 金额（元）、笔数是字符串，提交时转。R24.1 校验 #4 – #6 在这里先查一遍，服务端再查
const formSchema = z
  .object({
    type: z.enum(CONDITION_TYPES, { error: '选择类型' }),
    outcome: z.enum(CONDITION_OUTCOMES, { error: '选择结果' }),
    amount: z.string(),
    depositFilter: z.enum(DEPOSIT_FILTERS),
    cardCount: z.string(),
    description: z.string(),
    effectiveFrom: z.iso.date(),
  })
  .superRefine((v, ctx) => {
    if (hasAmount(v.type)) {
      let cents: number | null = null;
      try {
        cents = parseAmountToCents(v.amount);
      } catch {
        // 格式不对或是 0，下面一起报
      }
      if (cents === null || cents <= 0) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: '金额要大于 $0' });
      }
    }
    if (v.type === 'linked_card_count' && !/^[1-9]\d{0,8}$/.test(v.cardCount.trim())) {
      ctx.addIssue({ code: 'custom', path: ['cardCount'], message: '笔数至少 1 笔' });
    }
    if (v.type === 'other' && v.description.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['description'], message: '写一下条件是什么' });
    }
  });

type FormInput = z.input<typeof formSchema>;
type FormValues = z.output<typeof formSchema>;

// 只传这个类型用得到的参数，其他是 null
function toParams(v: FormValues): ConditionParamsInput {
  return {
    type: v.type,
    outcome: v.outcome,
    amountCents: hasAmount(v.type) ? parseAmountToCents(v.amount) : null,
    depositFilter: hasAmount(v.type) ? v.depositFilter : null,
    cardCount: v.type === 'linked_card_count' ? Number(v.cardCount.trim()) : null,
    description: v.type === 'other' ? v.description.trim() : null,
  };
}

// 整数分 → "2000.00"，不经过浮点数（金额 > 0）
function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// 服务端的字段名 → 表单字段名
const SERVER_FIELDS: Partial<Record<keyof ConditionErrors, keyof FormInput>> = {
  type: 'type',
  outcome: 'outcome',
  amountCents: 'amount',
  depositFilter: 'depositFilter',
  cardCount: 'cardCount',
  description: 'description',
  effectiveFrom: 'effectiveFrom',
};

type Props = {
  accountId: string;
  hasLinkedAccount: boolean; // 已保存的关联，表单里改了还没保存的不算
  condition: StoredCondition | null; // null = 添加
  today: string; // Melbourne
  onDone: () => void;
};

export function ConditionForm({ accountId, hasLinkedAccount, condition, today, onDone }: Props) {
  const [formError, setFormError] = useState<string | null>(null);
  const thisMonth = startOfMonth(today);
  // R24.1 生效月份不能晚于本月；历史只显示 12 个月，再早选了也看不到
  const monthOptions = lastTwelveMonths(today)
    .map((m) => m.start)
    .reverse();

  const form = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      type: condition?.type,
      outcome: condition?.outcome,
      amount: condition && 'amountCents' in condition ? centsToInput(condition.amountCents) : '',
      depositFilter: condition && 'depositFilter' in condition ? condition.depositFilter : 'any',
      cardCount: condition && 'cardCount' in condition ? String(condition.cardCount) : '',
      description: condition && 'description' in condition ? condition.description : '',
      effectiveFrom: thisMonth,
    } as FormInput,
  });

  const type = useWatch({ control: form.control, name: 'type' });

  async function onSubmit(values: FormValues) {
    setFormError(null);
    const params = toParams(values);
    const result = condition
      ? await updateConditionAction(condition.id, params)
      : await createConditionAction({ ...params, accountId, effectiveFrom: values.effectiveFrom });
    if (!result.ok) {
      const rest: string[] = [];
      for (const [key, message] of Object.entries(result.errors)) {
        const field = SERVER_FIELDS[key as keyof ConditionErrors];
        if (field) form.setError(field, { message });
        else rest.push(message);
      }
      if (rest.length > 0) setFormError(rest.join('；'));
      return;
    }
    toast.success(condition ? '已修改条件，从本月起按新参数算' : '已添加条件');
    onDone();
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>类型</FormLabel>
              <Select value={field.value ?? ''} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择类型" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {CONDITION_TYPES.map((t) => {
                    const disabled = isLinkedType(t) && !hasLinkedAccount;
                    return (
                      <SelectItem key={t} value={t} disabled={disabled}>
                        {CONDITION_TYPE_LABELS[t]}
                        {disabled && (
                          <span className="text-xs text-muted-foreground">先设置关联账户</span>
                        )}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {!hasLinkedAccount && (
                <FormDescription>关联账户类型要先在上面设置关联账户并保存</FormDescription>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        {hasAmount(type) && (
          <>
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>金额（$X）</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" autoComplete="off" placeholder="如 2000" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="depositFilter"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>哪些存入算数</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DEPOSIT_FILTERS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {DEPOSIT_FILTER_LABELS[f]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>利息和月费退回都不算存入；退款算</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </>
        )}

        {type === 'linked_card_count' && (
          <FormField
            control={form.control}
            name="cardCount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>笔数（N）</FormLabel>
                <FormControl>
                  <Input inputMode="numeric" autoComplete="off" placeholder="如 5" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {type === 'other' && (
          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>条件是什么</FormLabel>
                <FormControl>
                  <Input placeholder="如 每月登录一次 app" {...field} />
                </FormControl>
                <FormDescription>app 判断不了，每月去账户总览手动勾</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="outcome"
          render={({ field }) => (
            <FormItem>
              <FormLabel>满足了得到什么</FormLabel>
              <Select value={field.value ?? ''} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择结果" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {CONDITION_OUTCOMES.map((o) => (
                    <SelectItem key={o} value={o}>
                      {OUTCOME_OPTION_LABELS[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                bonus 和免月费分开算；同一个结果的条件全部满足才算拿到
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {condition ? (
          <p className="text-sm text-muted-foreground">
            修改后从本月起按新参数算，以前的月份照旧。
          </p>
        ) : (
          <FormField
            control={form.control}
            name="effectiveFrom"
            render={({ field }) => (
              <FormItem>
                <FormLabel>从哪个月开始</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {monthOptions.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m.slice(0, 7)}
                        {m === thisMonth && '（本月）'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>选更早的月份可以补看历史</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {formError && <p className="text-sm text-destructive">{formError}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onDone} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
