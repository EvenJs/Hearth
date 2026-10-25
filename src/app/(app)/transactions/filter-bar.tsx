'use client';

import { ChevronDown, RotateCcw, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
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
import { PERIOD_LABELS } from '@/lib/dashboard/format';
import type { TransactionType } from '@/lib/rules/split-edit';
import {
  filtersToSearchParams,
  type TransactionFilters,
  type TransactionStatus,
} from '@/lib/transactions/filters';
import type { PickerSections } from '@/lib/transactions/category-picker';
import { cn } from '@/lib/utils';
import { CategoryPicker, pickerLabel } from './category-picker';

// F8 筛选栏（M4-7）：条件全在 URL 参数里。下拉一改就跳转；商家和金额按回车或"应用"才生效
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

export function FilterBar({ filters, options }: Props) {
  // 外面改了筛选（快捷条件、清空）时，输入框跟着重置
  const key = filtersToSearchParams(filters).toString();
  return <FilterForm key={key} filters={filters} options={options} />;
}

function FilterForm({ filters, options }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const period = filters.period;
  const [custom, setCustom] = useState(typeof period === 'object');
  const [from, setFrom] = useState(typeof period === 'object' ? period.start : '');
  const [to, setTo] = useState(typeof period === 'object' ? period.end : '');
  const [merchant, setMerchant] = useState(filters.merchant ?? '');
  const params = filtersToSearchParams(filters);
  const [min, setMin] = useState(params.get('min') ?? '');
  const [max, setMax] = useState(params.get('max') ?? '');

  // 在当前 URL 参数上改几项，空值删掉
  function go(changes: Record<string, string | null>) {
    const p = filtersToSearchParams(filters);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v.trim() === '') p.delete(k);
      else p.set(k, v.trim());
    }
    const qs = p.toString();
    startTransition(() => router.push(qs ? `/transactions?${qs}` : '/transactions'));
  }

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
  }

  const periodValue = custom ? 'custom' : typeof period === 'string' ? period : ALL;
  const hasAny = params.toString() !== '';

  return (
    <form
      onSubmit={applyText}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-4 transition-opacity',
        pending && 'opacity-60',
      )}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
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
      </div>

      {custom && (
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
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="商家关键词"
            placeholder="商家关键词"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            aria-label="最小金额"
            placeholder="最小 $"
            inputMode="decimal"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            className="w-24"
          />
          <span className="text-muted-foreground">–</span>
          <Input
            aria-label="最大金额"
            placeholder="最大 $"
            inputMode="decimal"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            className="w-24"
          />
        </div>
        <Button type="submit" size="sm" className="h-9">
          应用
        </Button>
        {hasAny && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={() => startTransition(() => router.push('/transactions'))}
          >
            <RotateCcw className="size-4" />
            清空筛选
          </Button>
        )}
      </div>

      {/* 从导入结果页跳过来时带的 batch，筛选栏里没有对应的下拉，单独显示一个能去掉的标签 */}
      {filters.batchId && (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => go({ batch: null })}
            className="h-7 gap-1 rounded-full font-normal"
          >
            只看这次导入
            <X className="size-3.5" />
          </Button>
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
