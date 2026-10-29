'use client';

// 小票核对界面（设计图 14，M6.7-7，business-rules.md R20）
// variant = dialog：电脑弹窗，左边小票、右边"挂到哪笔交易"和"保存后的拆分"；sheet：手机全屏，竖着一列，一件一张小卡片
// 合计提示在浏览器里用纯函数实时算（R20.2）；拆分预览和保存都由服务器算（previewReceipt / saveReceipt），预览和最后存的一样
// 外面的容器（Dialog / Sheet）由入口组件提供
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CornerDownRight,
  Link2,
  Loader2,
  Percent,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { formatTxDate } from '@/app/(app)/transactions/format';
import { ToneDot } from '@/app/(app)/transactions/tx-badges';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatAud } from '@/lib/rules/money';
import { todayInMelbourne } from '@/lib/rules/periods';
import type { ReceiptPaymentMethod } from '@/lib/rules/receipt';
import { categoryColor } from '@/lib/transactions/category-color';
import {
  draftToForm,
  formToRaw,
  groupCategories,
  itemCategoryHints,
  liveCheck,
  type ReceiptFormValues,
  type ReceiptItemValue,
} from '@/lib/transactions/receipt-form';
import { cn } from '@/lib/utils';
import type {
  ReceiptCandidatesResult,
  ReceiptDraft,
  ReceiptPreview,
  ReceiptTarget,
} from '@/server/receipts';
import { previewReceiptAction, receiptCandidatesAction, saveReceiptAction } from './actions';

export type ReceiptReviewVariant = 'dialog' | 'sheet';

type Props = {
  variant: ReceiptReviewVariant;
  draft: ReceiptDraft;
  // 从交易详情"上传小票"进来：交易已经定了，不找候选（R20.4）
  fixedTransactionId?: string;
  onClose: () => void;
};

const FOLLOW = '__follow__'; // 分类下拉里的"跟主分类 / 跟上一件"
const NEW = '__new__'; // "都不是，新建一笔"
const CANDIDATE_DELAY_MS = 500;
const PREVIEW_DELAY_MS = 350;

const PAYMENT_LABEL: Record<ReceiptPaymentMethod, string> = {
  card: '刷卡',
  cash: '现金',
  unknown: '不确定',
};

let keySeq = 0;
const newKey = () => `r${++keySeq}`;

export function ReceiptReview({ variant, draft, fixedTransactionId, onClose }: Props) {
  const sheet = variant === 'sheet';
  const router = useRouter();
  const today = useMemo(() => todayInMelbourne(), []);
  const categories = draft.categories;
  // 分类下拉按一级分组，选项只写二级（设计图 14）
  const categoryGroups = useMemo(() => groupCategories(categories), [categories]);

  const [values, setValues] = useState<ReceiptFormValues>(() => draftToForm(draft.receipt, newKey));
  const live = useMemo(() => liveCheck(values, categories, today), [values, categories, today]);
  const hints = useMemo(() => itemCategoryHints(values.items), [values.items]);

  // ---------- R20.4 候选 ----------
  const [candidates, setCandidates] = useState<ReceiptCandidatesResult | null>(draft.candidates);
  const [dupDismissed, setDupDismissed] = useState(false);
  // 选中的交易 id、NEW，或 null（≥ 2 个候选时不默认选）
  const [target, setTarget] = useState<string | null>(() =>
    fixedTransactionId ? fixedTransactionId : defaultTarget(draft.candidates),
  );
  const touchedTarget = useRef(false);
  const [newAccountId, setNewAccountId] = useState<string | null>(draft.account.accountId);

  const { merchant, date, totalCents } = live.receipt;
  const candidateKey = `${merchant}|${date}|${totalCents}`;
  const firstCandidateKey = useRef(candidateKey);

  useEffect(() => {
    if (fixedTransactionId || candidateKey === firstCandidateKey.current) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const r = await receiptCandidatesAction({ merchant, date, totalCents }, values.cardLast4);
      if (stale || !r.ok) return;
      setCandidates(r.result);
      setTarget((current) => {
        const ids = r.result.candidates.map((c) => c.id);
        if (current === NEW && touchedTarget.current) return NEW;
        if (current !== null && current !== NEW && ids.includes(current)) return current;
        return defaultTarget(r.result);
      });
    }, CANDIDATE_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [candidateKey, fixedTransactionId, merchant, date, totalCents, values.cardLast4]);

  const targetSpec: ReceiptTarget | null =
    target === null
      ? null
      : target === NEW
        ? newAccountId
          ? { kind: 'new', accountId: newAccountId }
          : null
        : { kind: 'transaction', transactionId: target };

  // ---------- 保存后的拆分（服务器算，和保存一样） ----------
  // 结果连同算它用的输入一起存：输入变了，旧结果自动不算数，不用在 effect 里清空
  const [previewState, setPreviewState] = useState<{ key: string; result: ReceiptPreview } | null>(
    null,
  );
  const previewKey =
    live.check.ok && targetSpec
      ? JSON.stringify([formToRaw(values, categories), targetSpec])
      : null;
  const preview =
    previewKey !== null && previewState?.key === previewKey ? previewState.result : null;
  const previewing = previewKey !== null && preview === null;

  useEffect(() => {
    if (previewKey === null) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const [receipt, t] = JSON.parse(previewKey);
      const result = await previewReceiptAction({ receipt, target: t });
      if (!stale) setPreviewState({ key: previewKey, result });
    }, PREVIEW_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [previewKey]);

  // ---------- 保存 ----------
  const [saving, setSaving] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const previewOk = preview?.ok === true;
  const canSave = live.check.ok && targetSpec !== null && previewOk && !saving;

  async function save(confirmOverwrite: boolean) {
    if (!targetSpec || !live.check.ok) return;
    setSaving(true);
    const r = await saveReceiptAction({
      reader: draft.reader,
      receipt: formToRaw(values, categories),
      target: targetSpec,
      confirmOverwrite,
    });
    setSaving(false);
    if (r.ok) {
      setConfirmMessage(null);
      const id = r.transactionId;
      toast.success(`小票已保存 · ${formatAud(totalCents ?? 0)}`, {
        action: { label: '查看交易', onClick: () => router.push(`/transactions/${id}`) },
      });
      onClose();
      return;
    }
    if (r.code === 'needs_confirm') {
      setConfirmMessage(r.message);
      return;
    }
    setConfirmMessage(null);
    toast.error(r.message);
  }

  // ---------- 改表单 ----------
  const set = <K extends keyof ReceiptFormValues>(k: K, v: ReceiptFormValues[K]) =>
    setValues((prev) => ({ ...prev, [k]: v }));
  const setItem = (key: string, patch: Partial<ReceiptItemValue>) =>
    setValues((prev) => ({
      ...prev,
      items: prev.items.map((i) => (i.key === key ? { ...i, ...patch } : i)),
    }));
  const removeItem = (key: string) =>
    setValues((prev) => ({ ...prev, items: prev.items.filter((i) => i.key !== key) }));
  const addItem = () =>
    setValues((prev) => ({
      ...prev,
      items: [...prev.items, { key: newKey(), name: '', amount: '', categoryId: null }],
    }));
  const addDiscount = () =>
    setValues((prev) => ({
      ...prev,
      discounts: [...prev.discounts, { key: newKey(), label: 'DISCOUNT', amount: '-' }],
    }));
  const setDiscount = (key: string, patch: { label?: string; amount?: string }) =>
    setValues((prev) => ({
      ...prev,
      discounts: prev.discounts.map((d) => (d.key === key ? { ...d, ...patch } : d)),
    }));
  const removeDiscount = (key: string) =>
    setValues((prev) => ({ ...prev, discounts: prev.discounts.filter((d) => d.key !== key) }));

  const showDuplicate = !dupDismissed && !fixedTransactionId && candidates?.possibleDuplicate;
  const readFailed = draft.read.status === 'failed';

  const saveLabel = saving ? '保存中…' : '保存';

  // ---------- 各块 ----------

  const banners = (
    <>
      {readFailed && (
        <Banner tone="warn" icon={CircleAlert}>
          暂时识别不了，可以手动填
        </Banner>
      )}
      {showDuplicate && (
        <Banner tone="warn" icon={AlertTriangle} onDismiss={() => setDupDismissed(true)}>
          可能已经上传过：{merchant || '这家店'} {date ? formatTxDate(date, today) : ''}{' '}
          {totalCents !== null ? formatAud(totalCents) : ''}
        </Banner>
      )}
    </>
  );

  const headerFields = (
    <section
      className={cn(
        'grid gap-3 rounded-xl border bg-muted/30 p-3',
        sheet ? 'grid-cols-2' : 'grid-cols-[1.4fr_1fr_1fr_1.2fr]',
      )}
    >
      <Field label="店名" id="receipt-merchant" className={sheet ? 'col-span-2' : undefined}>
        <Input
          id="receipt-merchant"
          value={values.merchant}
          maxLength={100}
          onChange={(e) => set('merchant', e.target.value)}
          placeholder="店名"
        />
      </Field>
      <Field label="日期" id="receipt-date" error={shown(values.date, live.errors.date)}>
        <Input
          id="receipt-date"
          type="date"
          max={today}
          value={values.date}
          onChange={(e) => set('date', e.target.value)}
          aria-invalid={Boolean(shown(values.date, live.errors.date)) || undefined}
        />
      </Field>
      <Field label="总额" id="receipt-total" error={shown(values.total, live.errors.total)}>
        <Input
          id="receipt-total"
          inputMode="decimal"
          className="text-right font-mono tabular-nums"
          value={values.total}
          onChange={(e) => set('total', e.target.value)}
          placeholder="0.00"
          aria-invalid={Boolean(shown(values.total, live.errors.total)) || undefined}
        />
      </Field>
      <Field label="付款" id="receipt-payment" className={sheet ? 'col-span-2' : undefined}>
        <Select
          value={values.payment}
          onValueChange={(v) => set('payment', v as ReceiptPaymentMethod)}
        >
          <SelectTrigger id="receipt-payment" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {(['card', 'cash', 'unknown'] as const).map((m) => (
              <SelectItem key={m} value={m}>
                {m === 'card' && values.cardLast4
                  ? `刷卡 · 尾号 ${values.cardLast4}`
                  : PAYMENT_LABEL[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </section>
  );

  const categorySelect = (item: ReceiptItemValue, index: number) => {
    const hint = hints[index];
    const followLabel = hint === 'previous' ? '跟上一件' : '跟主分类';
    return (
      <Select
        value={item.categoryId ?? FOLLOW}
        onValueChange={(v) => setItem(item.key, { categoryId: v === FOLLOW ? null : v })}
      >
        <SelectTrigger
          aria-label={`${item.name || '商品'} 的分类`}
          className={cn(
            'w-full min-w-0',
            sheet && 'h-11',
            hint !== 'set' && 'border-dashed text-muted-foreground',
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-72">
          <SelectItem value={FOLLOW}>{followLabel}</SelectItem>
          {categoryGroups.map((g) => (
            <SelectGroup key={g.top}>
              <SelectLabel>{g.top}</SelectLabel>
              {g.items.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    );
  };

  const itemRows = values.items.map((item, index) => {
    const negative = hints[index] === 'previous';
    const error = shown(item.amount, live.errors.items[index]) ?? issueFor(live, 'item', index);
    if (sheet) {
      return (
        <li
          key={item.key}
          className={cn(
            'rounded-xl border bg-card p-3',
            negative && 'ml-5 border-dashed bg-muted/30',
          )}
        >
          <div className="flex items-center gap-2">
            {negative && <CornerDownRight className="size-4 shrink-0 text-muted-foreground" />}
            <Input
              aria-label="商品名"
              value={item.name}
              maxLength={100}
              onChange={(e) => setItem(item.key, { name: e.target.value })}
              className="h-11 min-w-0 flex-1"
              placeholder="商品名"
            />
            <Input
              aria-label="金额"
              inputMode="decimal"
              value={item.amount}
              onChange={(e) => setItem(item.key, { amount: e.target.value })}
              className={cn(
                'h-11 w-24 text-right font-mono tabular-nums',
                negative && 'text-destructive',
              )}
              placeholder="0.00"
              aria-invalid={Boolean(error) || undefined}
            />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div className="min-w-0 flex-1">{categorySelect(item, index)}</div>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label={`删除 ${item.name || '这一件'}`}
              onClick={() => removeItem(item.key)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </li>
      );
    }
    return (
      <li
        key={item.key}
        className={cn(
          'grid grid-cols-[minmax(0,1fr)_6.5rem_13rem_2rem] items-center gap-2 border-b px-3 py-1.5 last:border-b-0',
          negative && 'bg-muted/30',
        )}
      >
        <div className="flex min-w-0 items-center gap-1">
          {negative && <CornerDownRight className="size-4 shrink-0 text-muted-foreground" />}
          <Input
            aria-label="商品名"
            value={item.name}
            maxLength={100}
            onChange={(e) => setItem(item.key, { name: e.target.value })}
            className="h-8 border-transparent shadow-none hover:border-input focus-visible:border-ring"
            placeholder="商品名"
          />
        </div>
        <div>
          <Input
            aria-label="金额"
            inputMode="decimal"
            value={item.amount}
            onChange={(e) => setItem(item.key, { amount: e.target.value })}
            className={cn(
              'h-8 border-transparent text-right font-mono tabular-nums shadow-none hover:border-input focus-visible:border-ring',
              negative && 'text-destructive',
            )}
            placeholder="0.00"
            aria-invalid={Boolean(error) || undefined}
          />
          {error && <p className="mt-0.5 text-right text-xs text-destructive">{error}</p>}
        </div>
        {categorySelect(item, index)}
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label={`删除 ${item.name || '这一件'}`}
          onClick={() => removeItem(item.key)}
        >
          <X className="size-4" />
        </Button>
      </li>
    );
  });

  const discountRows = values.discounts.map((d, index) => {
    const error =
      shown(d.amount.replace('-', ''), live.errors.discounts[index]) ??
      issueFor(live, 'discount', index);
    return (
      <li
        key={d.key}
        className={cn(
          'grid items-center gap-2',
          sheet
            ? 'grid-cols-[minmax(0,1fr)_6rem_2.75rem] rounded-xl border border-dashed bg-muted/30 p-3'
            : 'grid-cols-[minmax(0,1fr)_6.5rem_13rem_2rem] border-b px-3 py-1.5 last:border-b-0',
        )}
      >
        <div className="flex min-w-0 items-center gap-1">
          <Percent className="size-4 shrink-0 text-muted-foreground" />
          <Input
            aria-label="整单折扣名"
            value={d.label}
            maxLength={100}
            onChange={(e) => setDiscount(d.key, { label: e.target.value })}
            className={cn(sheet ? 'h-11' : 'h-8')}
          />
        </div>
        <Input
          aria-label="整单折扣金额"
          inputMode="decimal"
          value={d.amount}
          onChange={(e) => setDiscount(d.key, { amount: e.target.value })}
          className={cn(
            'text-right font-mono text-destructive tabular-nums',
            sheet ? 'h-11' : 'h-8',
          )}
          aria-invalid={Boolean(error) || undefined}
        />
        {!sheet && (
          <span className="text-xs text-muted-foreground">整单折扣，按比例分到各分类</span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn('text-muted-foreground', sheet ? 'size-11' : 'size-8')}
          aria-label="删除这个折扣"
          onClick={() => removeDiscount(d.key)}
        >
          {sheet ? <Trash2 className="size-4" /> : <X className="size-4" />}
        </Button>
        {error && <p className="col-span-full text-xs text-destructive">{error}</p>}
      </li>
    );
  });

  const totalsPill = <TotalsPill live={live} />;

  const itemsBlock = (
    <section>
      {sheet ? (
        <h3 className="mb-2 text-base font-semibold">明细（{values.items.length} 件）</h3>
      ) : null}
      {values.items.length === 0 && values.discounts.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有商品，加一件
        </div>
      ) : sheet ? (
        <ul className="flex flex-col gap-2">
          {itemRows}
          {discountRows}
        </ul>
      ) : (
        <div className="rounded-xl border">
          <div className="grid grid-cols-[minmax(0,1fr)_6.5rem_13rem_2rem] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>商品</span>
            <span className="text-right">金额</span>
            <span>分类</span>
            <span />
          </div>
          <ul>
            {itemRows}
            {discountRows}
          </ul>
        </div>
      )}
      <div className={cn('mt-3 flex flex-wrap items-center gap-2', sheet && 'grid grid-cols-2')}>
        <Button variant={sheet ? 'outline' : 'ghost'} size={sheet ? 'lg' : 'sm'} onClick={addItem}>
          <Plus className="size-4" />
          加一件
        </Button>
        <Button
          variant={sheet ? 'outline' : 'ghost'}
          size={sheet ? 'lg' : 'sm'}
          onClick={addDiscount}
        >
          <Percent className="size-4" />
          整单折扣
        </Button>
        {!sheet && <div className="ml-auto">{totalsPill}</div>}
      </div>
      {sheet && <div className="mt-3">{totalsPill}</div>}
    </section>
  );

  const targetBlock = fixedTransactionId ? (
    <Card title="挂到这笔交易" icon={Link2}>
      {preview?.ok && preview.transaction ? (
        <div className="text-sm">
          <p className="font-medium tabular-nums">
            {formatTxDate(preview.transaction.date, today)} ·{' '}
            {formatAud(preview.transaction.amountCents)}
          </p>
          <p className="text-muted-foreground">
            {preview.transaction.accountName} · {preview.transaction.merchant}
          </p>
          {preview.extraCents > 0 && (
            <p className="mt-2 rounded-md bg-muted px-2 py-1 text-xs">
              交易比小票多 {formatAud(preview.extraCents)}，单独记一行未分类
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">填好小票后显示这笔交易和差额</p>
      )}
    </Card>
  ) : (
    <Card title="挂到哪笔交易" icon={Link2}>
      <div role="radiogroup" aria-label="挂到哪笔交易" className="flex flex-col gap-2">
        {(candidates?.candidates ?? []).map((c) => (
          <RadioCard
            key={c.id}
            checked={target === c.id}
            large={sheet}
            onSelect={() => {
              touchedTarget.current = true;
              setTarget(c.id);
            }}
          >
            <span className="font-medium tabular-nums">
              {formatTxDate(c.date, today)} · {formatAud(c.amountCents)}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {c.accountName} · {c.merchant}
            </span>
            <span className="mt-1 flex flex-wrap gap-1">
              {values.cardLast4 && c.cardLast4 === values.cardLast4 && (
                <Badge variant="secondary" className="text-[11px]">
                  卡号相同
                </Badge>
              )}
              {c.status === 'pending' && (
                <Badge variant="outline" className="text-[11px]">
                  待确认
                </Badge>
              )}
            </span>
          </RadioCard>
        ))}
        {candidates && candidates.candidates.length >= 2 && target === null && (
          <p className="text-xs text-muted-foreground">
            有 {candidates.candidates.length} 笔可能是，选一笔
          </p>
        )}
        <RadioCard
          checked={target === NEW}
          large={sheet}
          onSelect={() => {
            touchedTarget.current = true;
            setTarget(NEW);
          }}
        >
          <span className="font-medium">
            {candidates && candidates.candidates.length > 0 ? '都不是，新建一笔' : '新建一笔'}
          </span>
          {candidates === null && (
            <span className="block text-xs text-muted-foreground">
              填好日期和总额后找匹配的交易
            </span>
          )}
        </RadioCard>
        {target === NEW && (
          <Field label="记在哪个账户" id="receipt-new-account">
            <Select value={newAccountId ?? undefined} onValueChange={setNewAccountId}>
              <SelectTrigger id="receipt-new-account" className={cn('w-full', sheet && 'h-11')}>
                <SelectValue placeholder="选账户" />
              </SelectTrigger>
              <SelectContent position="popper">
                {draft.accounts
                  .filter(
                    (a) =>
                      draft.account.cardAccountIds.length <= 1 ||
                      draft.account.cardAccountIds.includes(a.id),
                  )
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>
    </Card>
  );

  const previewBlock = (
    <Card title="保存后的拆分" icon={null} aside="按分类合计">
      <PreviewBody
        preview={preview}
        loading={previewing}
        ready={previewKey !== null}
        wide={sheet}
      />
    </Card>
  );

  const confirmDialog = (
    <AlertDialog open={confirmMessage !== null} onOpenChange={(o) => !o && setConfirmMessage(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>用小票覆盖？</AlertDialogTitle>
          <AlertDialogDescription>{confirmMessage}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
          <Button onClick={() => save(true)} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            覆盖并保存
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (sheet) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-2 border-b px-2 py-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="关闭"
            onClick={onClose}
          >
            <X className="size-5" />
          </Button>
          <div className="min-w-0 flex-1 text-center">
            {/* 读屏用的标题是外面 Sheet 的 SheetTitle，这里只是显示 */}
            <p aria-hidden className="text-base font-semibold">
              核对小票
            </p>
            <p className="truncate text-xs text-muted-foreground">分类是建议，可以改</p>
          </div>
          <Button
            variant="ghost"
            className="h-11 text-primary"
            disabled={!canSave}
            onClick={() => save(false)}
          >
            {saveLabel}
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex flex-col gap-4 pb-4">
            {banners}
            {headerFields}
            {itemsBlock}
            {targetBlock}
            {previewBlock}
          </div>
        </div>
        <footer className="border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button
            size="lg"
            className="h-12 w-full text-base"
            disabled={!canSave}
            onClick={() => save(false)}
          >
            {saving ? <Loader2 className="size-5 animate-spin" /> : <Save className="size-5" />}
            {saving ? '保存中…' : '保存并挂到交易'}
          </Button>
        </footer>
        {confirmDialog}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {banners}
      <div className="grid grid-cols-[minmax(0,1fr)_20rem] gap-5">
        <div className="flex min-w-0 flex-col gap-4">
          {headerFields}
          {itemsBlock}
        </div>
        <div className="flex flex-col gap-4">
          {targetBlock}
          {previewBlock}
        </div>
      </div>
      <footer className="-mx-6 -mb-6 flex items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button disabled={!canSave} onClick={() => save(false)}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {saveLabel}
        </Button>
      </footer>
      {confirmDialog}
    </div>
  );
}

// ---------- 小组件 ----------

// R20.4：1 个候选默认选中；0 个按 R20.5 新建；≥ 2 个不默认选；还没找（日期、总额没填）先当新建
function defaultTarget(c: ReceiptCandidatesResult | null): string | null {
  if (c === null || c.candidates.length === 0) return NEW;
  return c.defaultId;
}

// 空着的字段先不标红（手动填刚打开时全是空的）；填了但格式不对才显示。空的照样不能保存
function shown(value: string, error: string | undefined): string | undefined {
  return value.trim() === '' ? undefined : error;
}

// checkReceipt 里标在某一行的问题（金额为 0、折扣不是负数）
function issueFor(live: ReturnType<typeof liveCheck>, kind: 'item' | 'discount', index: number) {
  if (live.check.ok) return undefined;
  const codes = kind === 'item' ? ['item_zero'] : ['discount_not_negative'];
  return live.check.issues.find((i) => codes.includes(i.code) && 'index' in i && i.index === index)
    ?.message;
}

function TotalsPill({ live }: { live: ReturnType<typeof liveCheck> }) {
  const { itemsCents, discountsCents, diffCents, receipt } = live;
  if (
    itemsCents === null ||
    discountsCents === null ||
    receipt.totalCents === null ||
    diffCents === null
  ) {
    return (
      <p className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
        填好总额和每件金额后核对合计
      </p>
    );
  }
  const sum = itemsCents + discountsCents;
  const detail =
    discountsCents !== 0
      ? `商品 ${formatAud(itemsCents)} − 折扣 ${formatAud(-discountsCents)} = ${formatAud(sum)}`
      : `商品合计 ${formatAud(sum)}`;
  if (diffCents === 0) {
    return (
      <p className="flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
        <CheckCircle2 className="size-4" />
        {detail} = 总额 {formatAud(receipt.totalCents)}（合计对上了）
      </p>
    );
  }
  return (
    <p
      role="alert"
      className="flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/5 px-3 py-1 text-xs text-destructive"
    >
      <CircleAlert className="size-4" />
      {detail}，总额 {formatAud(receipt.totalCents)}，差 {formatAud(Math.abs(diffCents))}
    </p>
  );
}

function PreviewBody({
  preview,
  loading,
  ready,
  wide,
}: {
  preview: ReceiptPreview | null;
  loading: boolean;
  ready: boolean;
  wide: boolean; // 手机上一行够宽，写全路径；电脑右栏窄，只写二级，鼠标悬停看全路径
}) {
  if (!ready) {
    return <p className="text-sm text-muted-foreground">合计对上、选好挂到哪笔后显示</p>;
  }
  if (loading || preview === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        计算中…
      </p>
    );
  }
  if (!preview.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {preview.message}
      </p>
    );
  }
  const total = preview.rows.reduce((s, r) => s + r.amountCents, 0);
  return (
    <div>
      <ul className="flex flex-col gap-2 rounded-lg bg-card p-3 text-sm">
        {preview.rows.map((r) => (
          <li key={r.categoryId} className="flex items-start gap-2">
            <ToneDot tone={rowTone(r)} className="mt-1.5" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate" title={r.categoryLabel}>
                  {wide
                    ? r.categoryLabel
                    : (r.categoryLabel.split(' / ').at(-1) ?? r.categoryLabel)}
                </span>
                {r.isPrimary && (
                  <Badge variant="secondary" className="shrink-0 px-1.5 text-[11px]">
                    主
                  </Badge>
                )}
              </span>
              <span className="block text-xs text-muted-foreground">{r.memberName}</span>
            </span>
            <span className="shrink-0 text-right font-mono tabular-nums">
              {formatAud(r.amountCents)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-right text-xs text-muted-foreground">
        合计 {formatAud(total)} = 交易金额
      </p>
    </div>
  );
}

function rowTone(r: { categoryLabel: string; categorySource: string; categoryId: string }) {
  if (r.categorySource === 'system') return 'uncategorized' as const;
  const top = r.categoryLabel.split(' / ')[0];
  return categoryColor({ topId: top, topName: top, kind: 'expense', systemKey: null });
}

function Banner({
  tone,
  icon: Icon,
  children,
  onDismiss,
}: {
  tone: 'warn';
  icon: typeof AlertTriangle;
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
        tone === 'warn' &&
          'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="关掉提示"
          onClick={onDismiss}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}

function Card({
  title,
  icon: Icon,
  aside,
  children,
}: {
  title: string;
  icon: typeof Link2 | null;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-muted/30 p-4">
      <div className="mb-3 flex items-center gap-2">
        {Icon && <Icon className="size-4 text-primary" />}
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside && <span className="ml-auto text-xs text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  id,
  error,
  className,
  children,
}: {
  label: string;
  id: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function RadioCard({
  checked,
  large,
  onSelect,
  children,
}: {
  checked: boolean;
  large: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border bg-card text-left text-sm transition-colors',
        large ? 'p-3.5' : 'p-3',
        checked ? 'border-primary ring-1 ring-primary' : 'hover:bg-muted/50',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
          checked ? 'border-primary' : 'border-muted-foreground/40',
        )}
      >
        {checked && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}
