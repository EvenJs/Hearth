'use client';

// R23.3 手动校准：填某天结束时的余额，保存后提示和算出来的差多少；下面是手动填过的余额，填错了删掉
// 没锚点的账户"填一次余额"也走这里。差额每次实时算，不存，所以列表里不显示历史差额
import { zodResolver } from '@hookform/resolvers/zod';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
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
import { formatAud, parseBalanceToCents } from '@/lib/rules/money';
import { addDays } from '@/lib/rules/periods';
import type { AccountBalance } from '@/server/balances';
import { addManualBalanceAction, deleteManualBalanceAction } from './actions';
import { formatDiff } from './format-diff';

type Values = { date: string; balance: string };

function isBalance(v: string): boolean {
  try {
    parseBalanceToCents(v);
    return true;
  } catch {
    return false;
  }
}

// 界面上的校验；服务端用 src/server/balances.ts 的 schema 再校验一次
function makeSchema(today: string) {
  return z.object({
    date: z.iso.date('选一个日期').refine((d) => d <= today, '日期不能晚于今天'),
    balance: z
      .string()
      .trim()
      .min(1, '填余额')
      .refine(isBalance, '金额格式不对，如 1200.50 或 -350'),
  });
}

// diffCents：null = 前面没锚点不比较（R23.3 第 2 条）
type Saved = { diffCents: number | null };

type Props = {
  account: Pick<AccountBalance, 'id' | 'name' | 'balance' | 'manualBalances'>;
  today: string; // Melbourne 今天，服务端传进来
};

export function CalibrateButton({ account, today }: Props) {
  const [open, setOpen] = useState(false);
  const label = account.balance === null ? '填一次余额' : '校准';
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && <CalibrateDialog account={account} today={today} onClose={() => setOpen(false)} />}
    </>
  );
}

function CalibrateDialog({ account, today, onClose }: Props & { onClose: () => void }) {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AccountBalance['manualBalances'][number] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // R23.3：日期默认昨天，今天的交易可能还没全部入账
  const defaults: Values = { date: addDays(today, -1), balance: '' };
  const form = useForm<Values>({
    resolver: zodResolver(makeSchema(today)),
    defaultValues: defaults,
  });
  const submitting = form.formState.isSubmitting;

  async function onSubmit(values: Values) {
    setFormError(null);
    const result = await addManualBalanceAction({
      accountId: account.id,
      date: values.date,
      balanceCents: parseBalanceToCents(values.balance),
    });
    if (!result.ok) {
      const { date, balanceCents, accountId, form: other } = result.errors;
      if (date) form.setError('date', { message: date });
      if (balanceCents) form.setError('balance', { message: balanceCents });
      if (accountId || other) setFormError(accountId ?? other ?? null);
      return;
    }
    setSaved({ diffCents: result.diffCents });
  }

  function again() {
    form.reset(defaults);
    setSaved(null);
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      const result = await deleteManualBalanceAction(deleting.id);
      if (!result.ok) {
        toast.error(result.errors.form ?? '删除失败，请稍后再试');
        return;
      }
      toast.success('已删除');
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {account.balance === null ? '填一次余额' : '校准余额'} · {account.name}
          </DialogTitle>
          <DialogDescription>填的数会成为新的余额起点，之后的交易在它上面加减。</DialogDescription>
        </DialogHeader>

        {saved ? (
          <div className="flex flex-col gap-4">
            <SavedMessage diffCents={saved.diffCents} />
            <DialogFooter>
              <Button variant="outline" onClick={again}>
                再填一个
              </Button>
              <Button onClick={onClose}>完成</Button>
            </DialogFooter>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>日期</FormLabel>
                    <FormControl>
                      <Input type="date" max={today} className="w-44" {...field} />
                    </FormControl>
                    <FormDescription>
                      填这一天结束时网银显示的余额；今天的交易可能还没全部入账，所以默认昨天
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="balance"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>余额</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="如 1200.50"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>信用卡欠款填负数</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {formError && <p className="text-sm text-destructive">{formError}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                  取消
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? '保存中…' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}

        <section className="flex flex-col gap-2 border-t pt-4">
          <h3 className="text-sm font-medium">手动填过的余额</h3>
          {account.manualBalances.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有</p>
          ) : (
            <ul className="flex flex-col divide-y text-sm">
              {account.manualBalances.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="tabular-nums text-muted-foreground">{m.date}</span>
                  <span className="ml-auto tabular-nums">{formatAud(m.balanceCents)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`删除 ${m.date} 的余额`}
                    onClick={() => setDeleting(m)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">填错了删掉重填，不能改</p>
        </section>
      </DialogContent>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && !deleteBusy && setDeleting(null)}
      >
        {deleting && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删掉这条余额？</AlertDialogTitle>
              <AlertDialogDescription>
                {`
                ${deleting.date} 的 ${formatAud(deleting.balanceCents)}
                。删了以后余额按上一个锚点重新算，没有别的锚点就显示"还没有余额"。`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel>
              <Button variant="destructive" onClick={confirmDelete} disabled={deleteBusy}>
                {deleteBusy ? '删除中…' : '删除'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </Dialog>
  );
}

// R23.3：0 → 对上了；null → 第一次填，不比较；其他 → 差额提示，照样保存了
function SavedMessage({ diffCents }: { diffCents: number | null }) {
  if (diffCents === null) return <p className="text-sm">已保存。这是第一个余额，没有可以比的。</p>;
  if (diffCents === 0)
    return <p className="text-sm text-emerald-700 dark:text-emerald-400">对上了</p>;
  return (
    <p className="text-sm text-amber-700 dark:text-amber-400">
      已保存。和算出来的差 <span className="tabular-nums">{formatDiff(diffCents)}</span>
      ，可能漏导了交易
    </p>
  );
}
