'use client';

// 没挂上的小票重新挂（M6.7-8，business-rules.md R20.4 到 R20.7）：核对界面"挂到哪笔交易"那一步
// 商品明细用保存时核对过的版本，这里不改。候选、预览、挂上都由服务器算，预览和 attachReceipt 走同一个计划
// 存的小票里没有卡号，候选不按卡号过滤，新建时账户由用户选（默认按 R20.5）
import { ChevronLeft, Link2, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { formatTxDate } from '@/app/(app)/transactions/format';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatAud } from '@/lib/rules/money';
import { todayInMelbourne } from '@/lib/rules/periods';
import type { ReceiptAttachOptions, ReceiptPreview, ReceiptTarget } from '@/server/receipts';
import {
  attachReceiptAction,
  previewAttachReceiptAction,
  receiptAttachOptionsAction,
} from './actions';
import { Field, PreviewBody, RadioCard, ReviewCard } from './receipt-review';

const NEW = '__new__';
const PREVIEW_DELAY_MS = 200;

// R20.4：1 个候选默认选中；0 个按 R20.5 新建；≥ 2 个不默认选
function defaultTarget(o: ReceiptAttachOptions): string | null {
  return o.candidates.length === 0 ? NEW : o.defaultId;
}

export function ReceiptAttachStep({
  receiptId,
  onBack,
  onDone,
}: {
  receiptId: string;
  onBack: () => void; // 回到没挂上的小票列表
  onDone: () => void; // 挂上了
}) {
  const [options, setOptions] = useState<ReceiptAttachOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    (async () => {
      const r = await receiptAttachOptionsAction(receiptId);
      if (stale) return;
      if (r.ok) setOptions(r);
      else setLoadError(r.message);
    })();
    return () => {
      stale = true;
    };
  }, [receiptId]);

  if (loadError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
        <Button variant="outline" onClick={onBack}>
          <ChevronLeft className="size-4" />
          返回列表
        </Button>
      </div>
    );
  }
  if (!options) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        找匹配的交易…
      </p>
    );
  }
  return <AttachForm options={options} onBack={onBack} onDone={onDone} />;
}

function AttachForm({
  options,
  onBack,
  onDone,
}: {
  options: ReceiptAttachOptions;
  onBack: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const today = useMemo(() => todayInMelbourne(), []);
  const { receipt, candidates, accounts } = options;
  const [target, setTarget] = useState<string | null>(() => defaultTarget(options));
  const [newAccountId, setNewAccountId] = useState<string | null>(options.account.accountId);

  const targetSpec: ReceiptTarget | null =
    target === null
      ? null
      : target === NEW
        ? newAccountId
          ? { kind: 'new', accountId: newAccountId }
          : null
        : { kind: 'transaction', transactionId: target };

  // ---------- 保存后的拆分（服务器算） ----------
  const [previewState, setPreviewState] = useState<{ key: string; result: ReceiptPreview } | null>(
    null,
  );
  const previewKey = targetSpec ? JSON.stringify(targetSpec) : null;
  const preview =
    previewKey !== null && previewState?.key === previewKey ? previewState.result : null;
  const previewing = previewKey !== null && preview === null;

  useEffect(() => {
    if (previewKey === null) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const result = await previewAttachReceiptAction(receipt.id, JSON.parse(previewKey));
      if (!stale) setPreviewState({ key: previewKey, result });
    }, PREVIEW_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [previewKey, receipt.id]);

  // ---------- 挂上 ----------
  const [saving, setSaving] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const canSave = targetSpec !== null && preview?.ok === true && !saving;

  async function save(confirmOverwrite: boolean) {
    if (!targetSpec) return;
    setSaving(true);
    const r = await attachReceiptAction(receipt.id, targetSpec, confirmOverwrite);
    setSaving(false);
    if (r.ok) {
      setConfirmMessage(null);
      const id = r.transactionId;
      toast.success(`小票已挂上 · ${formatAud(receipt.totalCents)}`, {
        action: { label: '查看交易', onClick: () => router.push(`/transactions/${id}`) },
      });
      onDone();
      return;
    }
    if (r.code === 'needs_confirm') {
      setConfirmMessage(r.message);
      return;
    }
    setConfirmMessage(null);
    toast.error(r.message);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-xl border bg-muted/30 px-4 py-3 text-sm">
        <span className="min-w-0 font-medium break-words">{receipt.merchant || '小票'}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatTxDate(receipt.receiptDate, today)} · {formatAud(receipt.totalCents)}
        </span>
      </div>

      <ReviewCard title="挂到哪笔交易" icon={Link2}>
        <div role="radiogroup" aria-label="挂到哪笔交易" className="flex flex-col gap-2">
          {candidates.map((c) => (
            <RadioCard
              key={c.id}
              checked={target === c.id}
              large={false}
              onSelect={() => setTarget(c.id)}
            >
              <span className="font-medium tabular-nums">
                {formatTxDate(c.date, today)} · {formatAud(c.amountCents)}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {c.accountName} · {c.merchant}
              </span>
              {c.status === 'pending' && (
                <Badge variant="outline" className="mt-1 text-[11px]">
                  待确认
                </Badge>
              )}
            </RadioCard>
          ))}
          {candidates.length >= 2 && target === null && (
            <p className="text-xs text-muted-foreground">有 {candidates.length} 笔可能是，选一笔</p>
          )}
          {candidates.length === 0 && (
            <p className="text-xs text-muted-foreground">
              没找到金额一样、日期在小票当天到 3 天后的交易
            </p>
          )}
          <RadioCard checked={target === NEW} large={false} onSelect={() => setTarget(NEW)}>
            <span className="font-medium">
              {candidates.length > 0 ? '都不是，新建一笔' : '新建一笔'}
            </span>
          </RadioCard>
          {target === NEW && (
            <Field label="记在哪个账户" id="attach-new-account">
              <Select value={newAccountId ?? undefined} onValueChange={setNewAccountId}>
                <SelectTrigger id="attach-new-account" className="w-full">
                  <SelectValue placeholder="选账户" />
                </SelectTrigger>
                <SelectContent position="popper">
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
      </ReviewCard>

      <ReviewCard title="保存后的拆分" icon={null} aside="按分类合计">
        <PreviewBody
          preview={preview}
          loading={previewing}
          ready={previewKey !== null}
          wide={false}
          notReadyText="选好挂到哪笔后显示"
        />
        {preview?.ok && preview.extraCents > 0 && (
          <p className="mt-2 rounded-md bg-muted px-2 py-1 text-xs">
            交易比小票多 {formatAud(preview.extraCents)}，单独记一行未分类
          </p>
        )}
      </ReviewCard>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <Button variant="ghost" onClick={onBack} disabled={saving}>
          <ChevronLeft className="size-4" />
          返回列表
        </Button>
        <Button disabled={!canSave} onClick={() => save(false)}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
          {saving ? '挂上中…' : '挂上'}
        </Button>
      </div>

      <AlertDialog
        open={confirmMessage !== null}
        onOpenChange={(o) => !o && setConfirmMessage(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>用小票覆盖？</AlertDialogTitle>
            <AlertDialogDescription>{confirmMessage}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <Button onClick={() => save(true)} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              覆盖并挂上
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
