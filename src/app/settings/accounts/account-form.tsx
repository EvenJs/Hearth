'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
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
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  BANKS,
  BANK_LABELS,
  accountInputSchema,
  type AccountInput,
  type AccountValues,
} from '@/lib/accounts/account-input';
import { canImportCsv } from '@/lib/import/banks';
import type { Account } from '@/server/accounts';
import type { Member } from '@/server/members';
import { saveAccountAction } from './actions';

type Props = {
  account: Account | null; // null = 新建
  members: Member[];
  onDone: () => void;
};

export function AccountForm({ account, members, onDone }: Props) {
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<AccountInput, unknown, AccountValues>({
    resolver: zodResolver(accountInputSchema),
    defaultValues: account
      ? {
          name: account.name,
          bank: account.bank,
          type: account.type,
          defaultMemberId: account.defaultMemberId,
          numberSuffix: account.numberSuffix ?? '',
        }
      : // 新建时银行、类型、归属人不预选，避免没注意就保存
        ({ name: '', numberSuffix: '' } as AccountInput),
  });

  const bank = useWatch({ control: form.control, name: 'bank' });
  const type = useWatch({ control: form.control, name: 'type' });
  const isCash = type === 'cash';

  async function onSubmit() {
    setFormError(null);
    // 传原始输入，服务端用同一个 schema 再校验一次
    const result = await saveAccountAction(account?.id ?? null, form.getValues());
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        form.setError(field as keyof AccountInput, { message });
      }
      if (!result.fieldErrors) setFormError(result.message);
      return;
    }
    toast.success(account ? '已保存' : '已新增账户');
    onDone();
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-5 px-4 pb-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>账户名称</FormLabel>
              <FormControl>
                <Input placeholder="如 ANZ Joint、现金（我）" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="bank"
          render={({ field }) => (
            <FormItem>
              <FormLabel>银行</FormLabel>
              <Select value={field.value ?? ''} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择银行" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {BANKS.map((b) => (
                    <SelectItem key={b} value={b}>
                      {BANK_LABELS[b]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {bank && (
                <FormDescription>
                  {canImportCsv(bank) ? '可以导入 CSV' : '不能导入 CSV，只能手动录入'}
                </FormDescription>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>类型</FormLabel>
              <Select
                value={field.value ?? ''}
                onValueChange={(v) => {
                  field.onChange(v);
                  // 现金账户不填尾号
                  if (v === 'cash') form.setValue('numberSuffix', '', { shouldValidate: true });
                }}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择类型" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {ACCOUNT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {ACCOUNT_TYPE_LABELS[t]}
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
          name="defaultMemberId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>默认归属人</FormLabel>
              <Select value={field.value ?? ''} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择归属人" />
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
              <FormDescription>没有卡号、分类也没指定归属人时，用这个（R5）</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="numberSuffix"
          render={({ field }) => (
            <FormItem>
              <FormLabel>账号尾号</FormLabel>
              <FormControl>
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  placeholder={isCash ? '现金账户不填' : '如 6691'}
                  disabled={isCash}
                  className="font-mono"
                  {...field}
                  value={field.value ?? ''}
                />
              </FormControl>
              <FormDescription>
                只填最后 4 到 6 位数字，用来识别内部转账。可以不填。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

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
