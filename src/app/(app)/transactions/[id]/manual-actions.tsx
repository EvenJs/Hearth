'use client';

// 编辑、删除手动录入的整笔交易（R17.5，M6-5）
// 能不能改由 canEditManual 决定：不能的不显示按钮；能改不能删（有转账配对）时删除换成一行原因
// 字段规则全部在服务端（applyManualEdit），这里只把表单值传过去、显示字段错误
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLayoutEffect, useState, useTransition } from 'react';
import { useForm, useWatch } from 'react-hook-form';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { canEditManual, type ManualField } from '@/lib/rules/manual';
import { formatAud } from '@/lib/rules/money';
import { initialStatus } from '@/lib/rules/pending';
import type { Account } from '@/lib/rules/types';
import { centsToAmountInput } from '@/lib/transactions/split-form';
import type { TransactionDetail } from '@/server/transactions';
import { deleteManualAction, updateManualAction } from './actions';

export type EditableAccount = Pick<Account, 'id' | 'name' | 'bank'>;

type Props = {
  tx: TransactionDetail;
  accounts: EditableAccount[]; // 本家庭没归档的
  today: string;
  listHref: string; // 删完回 F8，带着原来的筛选
};

export function ManualActions({ tx, accounts, today, listHref }: Props) {
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);

  // 对话框是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(() => () => setDialog(null), []);

  const permission = canEditManual({
    source: tx.source,
    importBatchId: tx.importBatch?.id ?? null,
    transferPairId: tx.transferPairId,
  });
  if (!permission.canEdit) return null;

  return (
    <div className="flex flex-col gap-1.5 sm:items-end">
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setDialog('edit')}>
          <Pencil />
          编辑
        </Button>
        {permission.canDelete && (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setDialog('delete')}
          >
            <Trash2 />
            删除
          </Button>
        )}
      </div>
      {!permission.canDelete && permission.reason && (
        <p className="text-xs text-muted-foreground sm:max-w-64 sm:text-right">
          {permission.reason}
        </p>
      )}

      {dialog === 'edit' && (
        <EditDialog tx={tx} accounts={accounts} today={today} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && (
        <DeleteDialog tx={tx} listHref={listHref} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

// ---------- 编辑 ----------

type EditValues = { amount: string; description: string; accountId: string; date: string };
type EditErrors = Partial<Record<ManualField | 'form', string>>;

// 父组件只在打开时挂载它，关掉就卸载，所以每次打开都是当前的值
function EditDialog({
  tx,
  accounts,
  today,
  onClose,
}: {
  tx: TransactionDetail;
  accounts: EditableAccount[];
  today: string;
  onClose: () => void;
}) {
  const [errors, setErrors] = useState<EditErrors>({});
  const [saving, setSaving] = useState(false);
  const isExpense = tx.amountCents < 0;
  // R17.5：多个拆分时不能改金额
  const amountLocked = tx.splits.length > 1;
  // 交易的账户归档了也要能显示出来（不能再选它以外的归档账户）
  const accountListed = accounts.some((a) => a.id === tx.account.id);

  const form = useForm<EditValues>({
    defaultValues: {
      amount: centsToAmountInput(tx.amountCents),
      description: tx.rawDescription,
      accountId: tx.account.id,
      date: tx.date,
    },
  });
  const v = useWatch({ control: form.control }) as EditValues;

  function set(key: keyof EditValues, value: string) {
    form.setValue(key, value);
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function onSubmit() {
    if (saving) return;
    const values = form.getValues();
    setSaving(true);
    try {
      // 没变的字段服务端会跳过；金额锁住时不传
      const r = await updateManualAction(tx.id, {
        ...(amountLocked ? {} : { amount: values.amount }),
        description: values.description,
        accountId: values.accountId,
        date: values.date,
      });
      if (!r.ok) {
        setErrors(r.errors);
        if (r.errors.form) toast.error(r.errors.form);
        return;
      }
      if (!r.changed) {
        onClose();
        return;
      }
      // R8.1：换账户可能改了状态，提醒一下
      const account = accounts.find((a) => a.id === values.accountId);
      const status = account ? initialStatus(account) : tx.status;
      toast.success(
        status === tx.status
          ? '已保存'
          : `已保存，状态改为${status === 'confirmed' ? '已确认' : '待确认'}`,
      );
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑交易</DialogTitle>
          <DialogDescription>
            改日期、金额、描述、账户。分类、归属人和备注在下面的拆分里改。
          </DialogDescription>
        </DialogHeader>

        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="manual-edit-amount">金额（{isExpense ? '支出' : '收入'}）</Label>
              <span className="text-xs text-muted-foreground">要改支出 / 收入请删掉重记</span>
            </div>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                {isExpense ? '−$' : '+$'}
              </span>
              <Input
                id="manual-edit-amount"
                inputMode="decimal"
                autoComplete="off"
                className="pl-8 tabular-nums"
                disabled={amountLocked}
                aria-invalid={!!errors.amount}
                value={v.amount}
                onChange={(e) => set('amount', e.target.value)}
              />
            </div>
            {amountLocked && (
              <p className="text-sm text-muted-foreground">有多个拆分，先删掉其他拆分才能改金额</p>
            )}
            <FieldError message={errors.amount} />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="manual-edit-description">描述</Label>
            <Input
              id="manual-edit-description"
              autoComplete="off"
              maxLength={100}
              aria-invalid={!!errors.description}
              value={v.description}
              onChange={(e) => set('description', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">改描述不会重新猜分类</p>
            <FieldError message={errors.description} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor="manual-edit-account">账户</Label>
              <Select value={v.accountId} onValueChange={(id) => set('accountId', id)}>
                <SelectTrigger
                  id="manual-edit-account"
                  className="w-full"
                  aria-invalid={!!errors.accountId}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {!accountListed && (
                    <SelectItem value={tx.account.id} disabled>
                      {tx.account.name}（已归档）
                    </SelectItem>
                  )}
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.accountId} />
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor="manual-edit-date">日期</Label>
              <Input
                id="manual-edit-date"
                type="date"
                max={today}
                aria-invalid={!!errors.date}
                value={v.date}
                onChange={(e) => set('date', e.target.value)}
              />
              <FieldError message={errors.date} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-sm text-destructive">{message}</p>;
}

// ---------- 删除 ----------

function DeleteDialog({
  tx,
  listHref,
  onClose,
}: {
  tx: TransactionDetail;
  listHref: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const r = await deleteManualAction(tx.id);
      if (!r.ok) {
        toast.error(r.errors.form ?? '删除失败，请稍后再试');
        onClose();
        return;
      }
      toast.success(`已删除 ${formatAud(tx.amountCents)} · ${tx.merchant}`);
      router.push(listHref);
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这笔交易？</AlertDialogTitle>
          <AlertDialogDescription>
            {formatAud(tx.amountCents)} · {tx.merchant}，连同它的拆分一起删除，不能恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault(); // 等删完再关
              remove();
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
