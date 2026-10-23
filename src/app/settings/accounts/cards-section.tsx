'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CreditCard, Plus, Trash2 } from 'lucide-react';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
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
import { cardInputSchema, type CardInput, type CardValues } from '@/lib/accounts/card-input';
import type { Card } from '@/server/cards';
import type { Member } from '@/server/members';
import { createCardAction, deleteCardAction } from './actions';

type Props = {
  accountId: string;
  cards: Card[]; // 只含这个账户的卡
  members: Member[];
};

// 卡号后四位 → 归属人（F1、R5 第 3 优先级）。只在编辑已有账户时出现
export function CardsSection({ accountId, cards, members }: Props) {
  const [deleting, startDelete] = useTransition();

  const form = useForm<CardInput, unknown, CardValues>({
    resolver: zodResolver(cardInputSchema),
    defaultValues: { last4: '', label: '' } as CardInput,
  });

  async function onSubmit() {
    // 传原始输入，服务端用同一个 schema 再校验一次
    const values = form.getValues();
    const result = await createCardAction(accountId, values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        form.setError(field as keyof CardInput, { message });
      }
      if (!result.fieldErrors) toast.error(result.message);
      return;
    }
    toast.success(`已添加卡 ••${values.last4.trim()}`);
    // 保留归属人，方便连续添加
    form.reset({ last4: '', label: '', memberId: values.memberId });
  }

  function remove(c: Card) {
    startDelete(async () => {
      const result = await deleteCardAction(c.id);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`已删除卡 ••${c.last4}`);
    });
  }

  const submitting = form.formState.isSubmitting;

  return (
    <section className="flex flex-col gap-3 border-t px-4 pt-5 pb-4">
      <div>
        <h3 className="flex items-center gap-2 font-medium">
          <CreditCard className="size-4" />卡
        </h3>
        <p className="text-sm text-muted-foreground">
          导入时按流水里的卡号后四位判断谁刷的卡。分类指定了归属人时，以分类为准（R5）。
        </p>
      </div>

      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有卡。</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {cards.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="font-mono">••{c.last4}</span>
              <span>→ {c.memberName}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.label}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除卡 ${c.last4}`}
                title="删除"
                disabled={deleting}
                onClick={() => remove(c)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3"
          noValidate
        >
          <FormField
            control={form.control}
            name="last4"
            render={({ field }) => (
              <FormItem>
                <FormLabel>后四位</FormLabel>
                <FormControl>
                  <Input
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={4}
                    placeholder="1111"
                    className="bg-background font-mono"
                    {...field}
                  />
                </FormControl>
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
                <Select value={field.value ?? ''} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="w-full bg-background">
                      <SelectValue placeholder="选择" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="label"
            render={({ field }) => (
              <FormItem className="col-span-2">
                <FormLabel>备注（可选）</FormLabel>
                <FormControl>
                  <Input placeholder="如 我的借记卡" className="bg-background" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="col-span-2 flex justify-end">
            <Button type="submit" variant="outline" size="sm" disabled={submitting}>
              <Plus />
              {submitting ? '添加中…' : '添加卡'}
            </Button>
          </div>
        </form>
      </Form>
    </section>
  );
}
