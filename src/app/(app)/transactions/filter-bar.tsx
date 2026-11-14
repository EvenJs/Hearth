'use client';

import { ChevronDown, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLayoutEffect, useState, useTransition } from 'react';
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
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { PERIOD_LABELS } from '@/lib/dashboard/format';
import type { TransactionType } from '@/lib/rules/split-edit';
import {
  activeFilterCount,
  filtersToSearchParams,
  moreFilterCount,
  type TransactionFilters,
  type TransactionStatus,
} from '@/lib/transactions/filters';
import type { PickerSections } from '@/lib/transactions/category-picker';
import { cn } from '@/lib/utils';
import { CategoryPicker, pickerLabel } from './category-picker';

// F8 筛选栏（M4-7，M13-6 收起）：条件全在 URL 参数里。下拉一改就跳转；商家和金额按回车或"应用"才生效
// 改了任何条件都回到第 1 页（URL 里不带 page）
// 这里只拼 URL 参数，合不合法由服务端的 filtersFromSearchParams 判断（不合法的丢掉）

export type FilterOptions = {
  accounts: { id: string; name: string; isArchived: boolean }[];
  members: { id: string; name: string }[];
  categorySections: PickerSections; // 一级包含它所有的二级
};

const ALL = 'all'; // Radix Select 的值不能是空字符串

const TYPE_LABELS: Record<TransactionType, string> = {
  expense: '支出',
  income: '收入',
  internal_transfer: '内部转账',
  uncategorized: '未分类',
};

const STATUS_LABELS: Record<TransactionStatus, string> = {
  confirmed: '已确认',
  pending: '待确认',
};

type Props = { filters: TransactionFilters; options: FilterOptions };

// 在当前 URL 参数上改几项，空值删掉
function useFilterNav(filters: TransactionFilters) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function go(changes: Record<string, string | null>) {
    const p = filtersToSearchParams(filters);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v.trim() === '') p.delete(k);
      else p.set(k, v.trim());
    }
    const qs = p.toString();
    startTransition(() => router.push(qs ? `/transactions?${qs}` : '/transactions'));
  }
  const clear = () => startTransition(() => router.push('/transactions'));
  return { pending, go, clear };
}

// M13-6 第 10 条：电脑（lg 以上）外面只放时间段、账户、商家关键词，其他收进"更多筛选"；
// 窄屏整块收成一个"筛选"按钮，点开是底部的 Sheet
// 展开和 Sheet 开关放在这一层：下面的表单按 URL 重新挂载，改一个下拉不会把它们收起来
export function FilterBar({ filters, options }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { pending, go, clear } = useFilterNav(filters);
  // cacheComponents 下离开页面时 state 会留着，Sheet 是一次性的，页面被隐藏时关掉
  // 见 docs/tech-stack.md 2. 关键约定 "页面状态"
  useLayoutEffect(() => () => setSheetOpen(false), []);

  // 外面改了筛选（快捷条件、清空）时，输入框跟着重置
  const key = filtersToSearchParams(filters).toString();
  const count = activeFilterCount(filters);
  return (
    <>
      <div className="hidden lg:block">
        <FilterForm
          key={key}
          filters={filters}
          options={options}
          layout="desktop"
          moreOpen={moreOpen}
          onToggleMore={() => setMoreOpen((v) => !v)}
        />
      </div>

      <div
        className={cn(
          'flex flex-wrap items-center gap-2 transition-opacity lg:hidden',
          pending && 'opacity-60',
        )}
      >
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-9">
              <SlidersHorizontal className="size-4" />
              筛选{count > 0 && ` (${count})`}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>筛选</SheetTitle>
            </SheetHeader>
            <FilterForm
              key={key}
              filters={filters}
              options={options}
              layout="sheet"
              onApplied={() => setSheetOpen(false)}
            />
          </SheetContent>
        </Sheet>
        {key !== '' && (
          <Button type="button" variant="ghost" size="sm" className="h-9" onClick={clear}>
            <RotateCcw className="size-4" />
            清空筛选
          </Button>
        )}
        {filters.batchId && <BatchChip onRemove={() => go({ batch: null })} />}
      </div>
    </>
  );
}

// 从导入结果页跳过来时带的 batch，筛选栏里没有对应的下拉，单独显示一个能去掉的标签
function BatchChip({ onRemove }: { onRemove: () => void }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onRemove}
      className="h-7 gap-1 rounded-full font-normal"
    >
      只看这次导入
      <X className="size-3.5" />
    </Button>
  );
}

type FormProps = Props &
  (
    | { layout: 'desktop'; moreOpen: boolean; onToggleMore: () => void }
    | { layout: 'sheet'; onApplied: () => void }
  );

function FilterForm(props: FormProps) {
  const { filters, options } = props;
  const { pending, go, clear } = useFilterNav(filters);

  const period = filters.period;
  const [custom, setCustom] = useState(typeof period === 'object');
  const [from, setFrom] = useState(typeof period === 'object' ? period.start : '');
  const [to, setTo] = useState(typeof period === 'object' ? period.end : '');
  const [merchant, setMerchant] = useState(filters.merchant ?? '');
  const params = filtersToSearchParams(filters);
  const [min, setMin] = useState(params.get('min') ?? '');
  const [max, setMax] = useState(params.get('max') ?? '');

  const selectChange = (param: string) => (v: string) => go({ [param]: v === ALL ? null : v });

  function onPeriodChange(v: string) {
    if (v === 'custom') {
      setCustom(true); // 两个日期都填了再跳转
      return;
    }
    setCustom(false);
    go({ period: v === ALL ? null : v, from: null, to: null });
  }

  function applyText(e: React.FormEvent) {
    e.preventDefault();
    go({
      q: merchant,
      min,
      max,
      ...(custom ? { period: null, from: from || null, to: to || null } : {}),
    });
    if (props.layout === 'sheet') props.onApplied();
  }

  const periodValue = custom ? 'custom' : typeof period === 'string' ? period : ALL;
  const hasAny = params.toString() !== '';

  const periodField = (
    <Field label="时间段">
      <Select value={periodValue} onValueChange={onPeriodChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部时间</SelectItem>
          {Object.entries(PERIOD_LABELS).map(([v, label]) => (
            <SelectItem key={v} value={v}>
              {label}
            </SelectItem>
          ))}
          <SelectItem value="custom">自定义…</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );

  const accountField = (
    <Field label="账户">
      <Select value={filters.accountId ?? ALL} onValueChange={selectChange('account')}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部账户</SelectItem>
          {options.accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
              {a.isArchived && '（已归档）'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );

  const merchantField = (
    <Field label="商家">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="商家关键词"
          placeholder="商家关键词"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          className="pl-9"
        />
      </div>
    </Field>
  );

  // 收进"更多筛选"的那些
  const moreFields = (
    <>
      <Field label="归属人">
        <Select value={filters.memberId ?? ALL} onValueChange={selectChange('member')}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部归属人</SelectItem>
            {options.members.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {/* 一级包含它所有的二级 */}
      <Field label="分类">
        <CategoryPicker
          sections={options.categorySections}
          value={filters.categoryId ?? null}
          onSelect={(id) => go({ category: id })}
          mode="filter"
        >
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between px-3 font-normal"
          >
            <span className="truncate">
              {pickerLabel(options.categorySections, filters.categoryId ?? null) ?? '全部分类'}
            </span>
            <ChevronDown className="size-4 opacity-50" />
          </Button>
        </CategoryPicker>
      </Field>

      <Field label="类型">
        <Select value={filters.type ?? ALL} onValueChange={selectChange('type')}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部类型</SelectItem>
            {Object.entries(TYPE_LABELS).map(([v, label]) => (
              <SelectItem key={v} value={v}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="状态">
        <Select value={filters.status ?? ALL} onValueChange={selectChange('status')}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            {Object.entries(STATUS_LABELS).map(([v, label]) => (
              <SelectItem key={v} value={v}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="税前">
        <Select
          value={filters.isPreTax === undefined ? ALL : filters.isPreTax ? '1' : '0'}
          onValueChange={selectChange('pretax')}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>不限</SelectItem>
            <SelectItem value="1">税前</SelectItem>
            <SelectItem value="0">非税前</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {/* R22.4：否 = 没标或确认不是 */}
      <Field label="一次性">
        <Select
          value={filters.oneOff === undefined ? ALL : filters.oneOff ? '1' : '0'}
          onValueChange={selectChange('oneoff')}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>不限</SelectItem>
            <SelectItem value="1">是</SelectItem>
            <SelectItem value="0">否</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="金额">
        <div className="flex items-center gap-1.5">
          <Input
            aria-label="最小金额"
            placeholder="最小 $"
            inputMode="decimal"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            className="min-w-0"
          />
          <span className="text-muted-foreground">–</span>
          <Input
            aria-label="最大金额"
            placeholder="最大 $"
            inputMode="decimal"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            className="min-w-0"
          />
        </div>
      </Field>
    </>
  );

  const customRange = custom && (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">自定义时间段</span>
      <Input
        type="date"
        aria-label="开始日期"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        className="w-40"
      />
      <span className="text-muted-foreground">至</span>
      <Input
        type="date"
        aria-label="结束日期"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="w-40"
      />
      <span className="text-xs text-muted-foreground">两个都填了，点「应用」生效</span>
    </div>
  );

  const clearButton = hasAny && (
    <Button type="button" variant="ghost" size="sm" className="h-9" onClick={clear}>
      <RotateCcw className="size-4" />
      清空筛选
    </Button>
  );

  if (props.layout === 'sheet') {
    return (
      <form
        onSubmit={applyText}
        className={cn('flex flex-col gap-3 px-4 pb-4 transition-opacity', pending && 'opacity-60')}
      >
        <div className="grid grid-cols-2 gap-3">
          {periodField}
          {accountField}
        </div>
        {customRange}
        {merchantField}
        <div className="grid grid-cols-2 gap-3">{moreFields}</div>
        <div className="flex items-center gap-2">
          <Button type="submit" className="flex-1">
            应用
          </Button>
          {clearButton}
        </div>
      </form>
    );
  }

  const moreCount = moreFilterCount(filters);
  return (
    <form
      onSubmit={applyText}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-4 transition-opacity',
        pending && 'opacity-60',
      )}
    >
      <div className="flex items-end gap-3">
        <div className="w-40 shrink-0">{periodField}</div>
        <div className="w-56 shrink-0">{accountField}</div>
        <div className="min-w-0 flex-1">{merchantField}</div>
        <Button
          type="button"
          variant="outline"
          aria-expanded={props.moreOpen}
          onClick={props.onToggleMore}
          className="font-normal"
        >
          更多筛选{moreCount > 0 && ` (${moreCount})`}
          <ChevronDown
            className={cn('size-4 opacity-50 transition-transform', props.moreOpen && 'rotate-180')}
          />
        </Button>
        <Button type="submit">应用</Button>
        {clearButton}
      </div>

      {customRange}

      {props.moreOpen && (
        <div className="grid grid-cols-4 gap-3 xl:grid-cols-7">{moreFields}</div>
      )}

      {filters.batchId && (
        <div>
          <BatchChip onRemove={() => go({ batch: null })} />
        </div>
      )}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
