'use client';

// F3 快速录入的表单（设计图 05，M6-3）。电脑上放在弹窗里，M6-4 手机全屏复用
// 字段顺序：金额和支出 / 收入、描述、分类（常用 chips + "更多…"）、账户 / 日期 / 归属人
// 表单状态怎么变见 src/lib/transactions/quick-add.ts；保存时的校验全部在服务端（buildManualTransaction）
import { Check, ChevronDown, CircleCheck, Clock, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { CategoryPicker } from '@/app/(app)/transactions/category-picker';
import { ToneDot, toneOfTop } from '@/app/(app)/transactions/tx-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { EntryKind, ManualField } from '@/lib/rules/manual';
import { formatAud } from '@/lib/rules/money';
import {
  autoMember,
  changeKind,
  emptyValues,
  guessOnDescription,
  nextEntryValues,
  pickCategory,
  quickAddChips,
  quickAddSections,
  statusHint,
  toManualInput,
  type QuickAddValues,
} from '@/lib/transactions/quick-add';
import { parseSplitAmountInput } from '@/lib/transactions/split-form';
import { cn } from '@/lib/utils';
import { createQuickAddAction, type QuickAddData } from './actions';

const AUTO_MEMBER = '__auto__';
const GUESS_DELAY_MS = 400; // 描述停顿多久猜分类
const KINDS: { value: EntryKind; label: string }[] = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
];

type FieldErrors = Partial<Record<ManualField, string>>;

type Props = {
  data: QuickAddData | null; // null = 还在加载，金额已经能输
  loadError: string | null;
  onClose: () => void;
};

export function QuickAddForm({ data, loadError, onClose }: Props) {
  const amountRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const form = useForm<QuickAddValues>({
    defaultValues: emptyValues({ lastAccountId: null, today: '' }),
  });
  const values = useWatch({ control: form.control }) as QuickAddValues;
  const { kind, description, accountId, date, category, memberId } = values;

  // 数据回来时补上默认的账户和日期（金额可能已经输了，不能 reset 整个表单）
  useEffect(() => {
    if (!data) return;
    if (form.getValues('accountId') === null) form.setValue('accountId', data.lastAccountId);
    if (form.getValues('date') === '') form.setValue('date', data.today);
  }, [data, form]);

  // R17.2 描述停顿后猜分类；失焦时也猜一次（guessNow）
  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => guessNow(), GUESS_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [description, data]);

  function guessNow() {
    if (!data) return;
    const v = form.getValues();
    const next = guessOnDescription(v.category, v.description, v.kind, data.rules, data.categories);
    if (next !== v.category) form.setValue('category', next);
  }

  const memberCtx = useMemo(
    () =>
      data && {
        categories: data.categories,
        cards: data.cards,
        accounts: data.accounts,
      },
    [data],
  );
  const sections = useMemo(
    () => (data ? quickAddSections(data.categories, kind) : null),
    [data, kind],
  );
  const chips = data ? quickAddChips(data.frequent[kind], category.categoryId) : [];
  const auto = memberCtx ? autoMember(accountId, category.categoryId, memberCtx) : null;
  const account = data?.accounts.find((a) => a.id === accountId) ?? null;
  const hint = account ? statusHint(account) : null;

  const categoryById = useMemo(
    () => new Map((data?.categories ?? []).map((c) => [c.id, c])),
    [data],
  );
  const memberName = (id: string) => data?.members.find((m) => m.id === id)?.name ?? '';

  function setKind(next: EntryKind) {
    if (next === kind || !data) {
      form.setValue('kind', next);
      return;
    }
    const v = form.getValues();
    form.setValue('kind', next);
    form.setValue(
      'category',
      changeKind(v.category, next, v.description, data.rules, data.categories),
    );
  }

  function choose(id: string | null) {
    form.setValue('category', pickCategory(form.getValues('category'), id));
    setErrors((e) => ({ ...e, categoryId: undefined }));
  }

  async function save(mode: 'close' | 'next') {
    if (saving || !data) return;
    const v = form.getValues();
    const prepared = toManualInput(v);
    if (!prepared.ok) {
      setErrors(prepared.errors);
      return;
    }
    setSaving(true);
    try {
      const r = await createQuickAddAction(prepared.input);
      if (!r.ok) {
        const { form: formError, ...fieldErrors } = r.errors;
        setErrors(fieldErrors);
        if (formError) toast.error(formError);
        focusFirstError(fieldErrors);
        return;
      }
      setErrors({});
      const amount = parseSplitAmountInput(v.amount);
      const cents = amount.ok ? (v.kind === 'expense' ? -amount.cents : amount.cents) : 0;
      toast.success(`已记一笔 ${formatAud(cents)} · ${v.description.trim()}`);
      if (mode === 'close') {
        onClose();
      } else {
        // R17.4
        form.reset(nextEntryValues(v));
        amountRef.current?.focus();
      }
    } finally {
      setSaving(false);
    }
  }

  function focusFirstError(e: FieldErrors) {
    if (e.amount) amountRef.current?.focus();
    else if (e.description) document.getElementById('quick-add-description')?.focus();
  }

  // ⌘↵ / Ctrl↵ 保存。普通回车不提交（中文输入法选词会按回车）
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      void save('close');
    } else if (e.target instanceof HTMLInputElement) {
      e.preventDefault();
    }
  }

  const isMac = useIsMac();
  const shortcut = isMac ? '⌘↵' : 'Ctrl↵';

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save('close');
      }}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-5"
    >
      {/* 金额和支出 / 收入 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="quick-add-amount">金额</Label>
          <div role="radiogroup" aria-label="支出或收入" className="flex rounded-md bg-muted p-0.5">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={kind === k.value}
                onClick={() => setKind(k.value)}
                className={cn(
                  'rounded-sm px-3 py-1 text-sm transition-colors',
                  kind === k.value
                    ? k.value === 'income'
                      ? 'bg-emerald-600 text-white shadow-xs'
                      : 'bg-primary text-primary-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>
        <div className="relative">
          <span
            className={cn(
              'pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-2xl font-semibold',
              kind === 'income' ? 'text-emerald-600' : 'text-primary',
            )}
          >
            {kind === 'income' ? '+$' : '−$'}
          </span>
          <Input
            id="quick-add-amount"
            ref={amountRef}
            autoFocus
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            aria-invalid={!!errors.amount}
            className="h-16 pr-4 pl-14 text-right text-3xl font-semibold tabular-nums md:text-3xl"
            value={values.amount}
            onChange={(e) => {
              form.setValue('amount', e.target.value);
              if (errors.amount) setErrors((x) => ({ ...x, amount: undefined }));
            }}
          />
        </div>
        <FieldError message={errors.amount} />
      </div>

      {/* 描述 */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="quick-add-description">描述 / 商户</Label>
        <Input
          id="quick-add-description"
          autoComplete="off"
          placeholder="比如 Coffee Lab"
          maxLength={100}
          aria-invalid={!!errors.description}
          value={description}
          onChange={(e) => {
            form.setValue('description', e.target.value);
            if (errors.description) setErrors((x) => ({ ...x, description: undefined }));
          }}
          onBlur={guessNow}
        />
        <FieldError message={errors.description} />
      </div>

      {/* 分类：常用 chips + 更多… */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">分类</span>
          {category.guessed && (
            <Badge variant="secondary" className="gap-1 font-normal">
              <Sparkles className="size-3" />
              根据描述猜的
            </Badge>
          )}
          {!category.categoryId && data && (
            <span className="text-xs text-muted-foreground">不选就是未分类</span>
          )}
        </div>
        {data && sections ? (
          <div className="flex flex-wrap gap-2">
            {chips.map((id) => {
              const c = categoryById.get(id);
              if (!c) return null;
              const top = c.parentId ? categoryById.get(c.parentId) : c;
              const selected = id === category.categoryId;
              return (
                <Button
                  key={id}
                  type="button"
                  size="sm"
                  variant={selected ? 'default' : 'outline'}
                  aria-pressed={selected}
                  onClick={() => choose(id)}
                  title={top && top !== c ? `${top.nameEn} / ${c.nameEn}` : c.nameEn}
                  className="max-w-full"
                >
                  {top && !selected && (
                    <ToneDot
                      tone={toneOfTop({
                        id: top.id,
                        nameEn: top.nameEn,
                        kind: top.kind,
                        systemKey: top.systemKey,
                      })}
                    />
                  )}
                  <span className="truncate">{c.nameEn}</span>
                  {selected && category.guessed && (
                    <span className="text-xs font-normal opacity-80">猜的</span>
                  )}
                  {selected && <Check className="size-3.5" />}
                </Button>
              );
            })}
            <CategoryPicker
              sections={sections}
              value={category.categoryId}
              onSelect={(id) => choose(id)}
              mode="edit"
            >
              <Button type="button" size="sm" variant="outline">
                更多…
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            </CategoryPicker>
          </div>
        ) : (
          <Skeleton className="h-8" />
        )}
        <FieldError message={errors.categoryId} />
      </div>

      {/* 账户 / 日期 / 归属人 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="quick-add-account">账户</Label>
            {data && accountId && accountId === data.lastAccountId && (
              <span className="text-xs text-emerald-700 dark:text-emerald-400">上次使用</span>
            )}
          </div>
          {data ? (
            <Select
              value={accountId ?? ''}
              onValueChange={(id) => {
                form.setValue('accountId', id);
                setErrors((x) => ({ ...x, accountId: undefined }));
              }}
            >
              <SelectTrigger
                id="quick-add-account"
                className="w-full"
                aria-invalid={!!errors.accountId}
              >
                <SelectValue placeholder="选账户" />
              </SelectTrigger>
              <SelectContent position="popper">
                {data.accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Skeleton className="h-9" />
          )}
          <FieldError message={errors.accountId} />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor="quick-add-date">日期</Label>
          {data ? (
            <Input
              id="quick-add-date"
              type="date"
              max={data.today}
              required
              aria-invalid={!!errors.date}
              value={date}
              onChange={(e) => {
                form.setValue('date', e.target.value);
                setErrors((x) => ({ ...x, date: undefined }));
              }}
            />
          ) : (
            <Skeleton className="h-9" />
          )}
          <FieldError message={errors.date} />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor="quick-add-member">归属人</Label>
          {data ? (
            <Select
              value={memberId ?? AUTO_MEMBER}
              onValueChange={(id) => {
                form.setValue('memberId', id === AUTO_MEMBER ? null : id);
                setErrors((x) => ({ ...x, memberId: undefined }));
              }}
            >
              <SelectTrigger id="quick-add-member" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {/* R17.3：自动旁边显示 R5 算出来的人 */}
                <SelectItem value={AUTO_MEMBER}>
                  自动{auto ? `（${memberName(auto.memberId)}）` : ''}
                </SelectItem>
                {data.members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Skeleton className="h-9" />
          )}
          <FieldError message={errors.memberId} />
        </div>
      </div>

      {/* R8.1 状态提示 */}
      {hint && (
        <p className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {hint.status === 'confirmed' ? (
            <CircleCheck className="size-4 shrink-0 text-emerald-600" />
          ) : (
            <Clock className="size-4 shrink-0" />
          )}
          {hint.message}
        </p>
      )}

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}

      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center">
        <Button
          type="button"
          variant="ghost"
          disabled={!data || saving}
          onClick={() => void save('next')}
          className="sm:mr-auto"
        >
          保存并再记一笔
        </Button>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          取消
        </Button>
        <Button type="submit" disabled={!data || saving}>
          {saving ? '保存中…' : '保存'}
          <kbd className="rounded bg-primary-foreground/20 px-1.5 py-0.5 font-sans text-xs">
            {shortcut}
          </kbd>
        </Button>
      </div>
    </form>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-sm text-destructive">{message}</p>;
}

function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} />;
}

// 快捷键提示：Mac 显示 ⌘，其他显示 Ctrl。服务端渲染时没有 navigator，先当成 Mac
function useIsMac() {
  const [isMac, setIsMac] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);
  return isMac;
}
