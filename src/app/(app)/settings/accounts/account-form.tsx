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
import { Label } from '@/components/ui/label';
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
import { canImportStatement } from '@/lib/import/banks';
import { ACCOUNT_PURPOSES, ACCOUNT_PURPOSE_LABELS } from '@/lib/rules/balance';
import { parseBalanceToCents } from '@/lib/rules/money';
import type { Account } from '@/server/accounts';
import type { Member } from '@/server/members';
import { previewAccountSaveAction, saveAccountAction } from './actions';

// 选了银行以后的说明（R1、R1C、R1D、R1E）
const BANK_IMPORT_HINT: Record<Bank, string> = {
  anz: '可以导入 CSV 和 PDF 对账单，导对账单要填尾号',
  anz_plus: '导入 PDF 对账单（不能导 CSV），要填尾号',
  cba: '可以导入 CSV 和 PDF 对账单，导对账单要填尾号',
  cash: '不能导入，只能手动录入',
  other: '不能导入，只能手动录入',
};

// R6.4 弹窗：保存后会认成内部转账的 N 笔、对上了但不改的 M 笔，和当时的表单输入
type RedetectPrompt = { count: number; keptCount: number; input: AccountInput };

// R23.4 关联账户的"不关联"。Radix Select 的值不能是空字符串
const NO_LINK = '__none__';

type Props = {
  account: Account | null; // null = 新建
  accounts: Account[]; // 关联账户的候选
  members: Member[];
  onDone: () => void;
};

export function AccountForm({ account, accounts, members, onDone }: Props) {
  const [formError, setFormError] = useState<string | null>(null);
  // R23.1 开户余额（元），只有新建用。字符串不进 react-hook-form，提交时转分
  const [openingBalance, setOpeningBalance] = useState('0');
  const [openingBalanceError, setOpeningBalanceError] = useState<string | null>(null);
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
          purpose: account.purpose,
          linkedAccountId: account.linkedAccountId,
        }
      : // 新建时银行、类型、归属人不预选，避免没注意就保存
        ({ name: '', numberSuffix: '', purpose: 'everyday', linkedAccountId: null } as AccountInput),
  });

  const bank = useWatch({ control: form.control, name: 'bank' });
  const type = useWatch({ control: form.control, name: 'type' });
  const isCash = type === 'cash';

  // R23.4：下拉里去掉自己、已归档的、现金账户
  const linkOptions = accounts.filter(
    (a) => a.id !== account?.id && !a.isArchived && a.bank !== 'cash',
  );
  // 已经关联、后来归档了的账户不在候选里，单独放一项让它显示出来；不改就原样保存
  const keptLink =
    account?.linkedAccountId && !linkOptions.some((a) => a.id === account.linkedAccountId)
      ? {
          id: account.linkedAccountId,
          label: account.linkedAccountArchived
            ? `${account.linkedAccountName}（已归档）`
            : (account.linkedAccountName ?? ''),
        }
      : null;

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
    setOpeningBalanceError(null);
    // 传原始输入，服务端用同一个 schema 再校验一次
    const input = form.getValues();
    if (!account) {
      try {
        input.openingBalanceCents = parseBalanceToCents(openingBalance);
      } catch {
        setOpeningBalanceError('金额格式不对，如 1200.50 或 -350');
        return;
      }
    }
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
              <Select
                value={field.value ?? ''}
                onValueChange={(v) => {
                  field.onChange(v);
                  // R23.4：现金账户不能关联别的账户
                  if (v === 'cash') form.setValue('linkedAccountId', null);
                }}
              >
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
                  : canImportStatement(bank)
                    ? '只填最后 4 到 6 位数字，用来识别内部转账；导入 PDF 对账单时按尾号认账户，只导 CSV 可以不填。'
                    : '只填最后 4 到 6 位数字，用来识别内部转账。可以不填。'}
              </FormDescription>
              {canImportStatement(bank) && !field.value && (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  没填尾号导不了对账单
                </p>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="purpose"
          render={({ field }) => (
            <FormItem>
              <FormLabel>用途</FormLabel>
              <Select value={field.value ?? ''} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择用途" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {ACCOUNT_PURPOSES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {ACCOUNT_PURPOSE_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>这笔钱拿来干嘛，账户总览按这个分组</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {bank !== 'cash' && (
          <FormField
            control={form.control}
            name="linkedAccountId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>关联账户</FormLabel>
                <Select
                  value={field.value ?? NO_LINK}
                  onValueChange={(v) => field.onChange(v === NO_LINK ? null : v)}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NO_LINK}>不关联</SelectItem>
                    {keptLink && (
                      <SelectItem value={keptLink.id} disabled>
                        {keptLink.label}
                      </SelectItem>
                    )}
                    {linkOptions.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>可以不选，如 saver 关联到日常账户</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {!account && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="opening-balance">开户余额</Label>
            <Input
              id="opening-balance"
              inputMode="decimal"
              autoComplete="off"
              value={openingBalance}
              onChange={(e) => setOpeningBalance(e.target.value)}
              aria-invalid={openingBalanceError !== null}
            />
            <p className="text-sm text-muted-foreground">
              现在账户里有多少钱，信用卡欠款填负数。以后要改去账户总览校准
            </p>
            {openingBalanceError && (
              <p className="text-sm text-destructive">{openingBalanceError}</p>
            )}
          </div>
        )}

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
