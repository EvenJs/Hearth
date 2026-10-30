'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
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
  type Bank,
} from '@/lib/accounts/account-input';
import type { Account } from '@/server/accounts';
import type { Member } from '@/server/members';
import { previewAccountSaveAction, saveAccountAction } from './actions';

// 选了银行以后的说明（R1、R1C、R1D）
const BANK_IMPORT_HINT: Record<Bank, string> = {
  anz: '可以导入 CSV 和 PDF 对账单',
  anz_plus: '导入 PDF 对账单（不能导 CSV），要填尾号',
  cba: '可以导入 CSV',
  cash: '不能导入，只能手动录入',
  other: '不能导入，只能手动录入',
};

// R6.4 弹窗：保存后会认成内部转账的 N 笔、对上了但不改的 M 笔，和当时的表单输入
type RedetectPrompt = { count: number; keptCount: number; input: AccountInput };

type Props = {
  account: Account | null; // null = 新建
  members: Member[];
  onDone: () => void;
};

export function AccountForm({ account, members, onDone }: Props) {
  const [formError, setFormError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<RedetectPrompt | null>(null);
  const [saving, setSaving] = useState(false);

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

  function showErrors(result: { message: string; fieldErrors?: Partial<Record<string, string>> }) {
    for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
      form.setError(field as keyof AccountInput, { message });
    }
    if (!result.fieldErrors) setFormError(result.message);
  }

  // redetect：R6.4 弹窗里选了"改"
  async function save(input: AccountInput, redetect: boolean) {
    setSaving(true);
    try {
      const result = await saveAccountAction(account?.id ?? null, input, redetect);
      setPrompt(null);
      if (!result.ok) {
        showErrors(result);
        return;
      }
      const saved = account ? '已保存' : '已新增账户';
      toast.success(
        result.redetectedCount > 0
          ? `${saved}，${result.redetectedCount} 笔旧交易认成了内部转账`
          : saved,
      );
      onDone();
    } finally {
      setSaving(false);
    }
  }

  // 先预览 R6.4：有旧交易会认成内部转账就弹窗问，没有（或尾号是空的）直接保存
  async function onSubmit() {
    setFormError(null);
    // 传原始输入，服务端用同一个 schema 再校验一次
    const input = form.getValues();
    const preview = await previewAccountSaveAction(account?.id ?? null, input);
    if (!preview.ok) {
      showErrors(preview);
      return;
    }
    if (preview.count === 0) {
      await save(input, false);
      return;
    }
    setPrompt({ count: preview.count, keptCount: preview.keptCount, input });
  }

  const submitting = form.formState.isSubmitting || saving;

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
                  {BANK_IMPORT_HINT[bank]}
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
                {bank === 'anz_plus'
                  ? '只填最后 4 到 6 位数字。导入 PDF 对账单时按尾号认账户，ANZ Plus 账户要填。'
                  : '只填最后 4 到 6 位数字，用来识别内部转账。可以不填。'}
              </FormDescription>
              {bank === 'anz_plus' && !field.value && (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  没填尾号导不了对账单
                </p>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        {formError && <p className="text-sm text-destructive">{formError}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onDone} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" disabled={submitting || prompt !== null}>
            {submitting ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>

      <AlertDialog
        open={prompt !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setPrompt(null);
        }}
      >
        {prompt && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>认成内部转账？</AlertDialogTitle>
              <AlertDialogDescription>
                有 {prompt.count} 笔旧交易会认成内部转账
                {prompt.keptCount > 0 &&
                  `（另有 ${prompt.keptCount} 笔分类是手动的或拆分过，不改）`}
                。要改吗？
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
              <Button variant="outline" onClick={() => save(prompt.input, false)} disabled={saving}>
                不改，只保存账户
              </Button>
              <Button onClick={() => save(prompt.input, true)} disabled={saving}>
                {saving ? '保存中…' : '改'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </Form>
  );
}
