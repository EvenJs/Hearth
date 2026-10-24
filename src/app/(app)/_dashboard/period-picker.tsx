'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { dashboardHref, PERIOD_LABELS } from '@/lib/dashboard/format';
import type { PivotView } from '@/lib/dashboard/pivot-view';
import { periodRange, PRESET_PERIODS, type Period, type PresetPeriod } from '@/lib/rules/periods';
import { cn } from '@/lib/utils';

// R10.1 看板时间段：8 个选项，选了就写进 URL（和 F8 同样的参数）
// 自定义要两个日期都填了点"应用"才跳；填到一半离开再回来保留（tech-stack 2，筛选条件要留）
// 合不合法由服务端的 filtersFromSearchParams 判断，不合法的丢掉 → 回到默认的本月

// view：汇总表当前的切换，换时间段时带上不丢（M5-5）
type Props = { period: Period; memberId?: string; view?: PivotView; today: string };

export function PeriodPicker(props: Props) {
  // URL 变了（换了时间段、归属人）时重新挂载，日期框跟着当前时间段
  const { option, start, end } = props.period;
  return <PeriodForm key={`${option}:${start}:${end}:${props.memberId ?? ''}`} {...props} />;
}

function PeriodForm({ period, memberId, view, today }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [custom, setCustom] = useState(period.option === 'custom');
  const [from, setFrom] = useState(period.start);
  const [to, setTo] = useState(period.end);

  function go(next: Period) {
    startTransition(() => router.push(dashboardHref({ period: next, memberId }, view)));
  }

  function onChange(v: string) {
    if (v === 'custom') {
      setCustom(true); // 两个日期都填了再跳
      return;
    }
    setCustom(false);
    go(periodRange(v as PresetPeriod, today));
  }

  function apply(e: React.FormEvent) {
    e.preventDefault();
    if (!from || !to || from > to) return;
    go(periodRange({ start: from, end: to }, today));
  }

  const invalid = custom && from !== '' && to !== '' && from > to;

  return (
    <form
      onSubmit={apply}
      className={cn('flex flex-wrap items-center gap-2', pending && 'opacity-60')}
    >
      <Select value={custom ? 'custom' : period.option} onValueChange={onChange}>
        <SelectTrigger className="w-32" aria-label="时间段">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESET_PERIODS.map((p) => (
            <SelectItem key={p} value={p}>
              {PERIOD_LABELS[p]}
            </SelectItem>
          ))}
          <SelectItem value="custom">自定义…</SelectItem>
        </SelectContent>
      </Select>

      {custom && (
        <>
          <Input
            type="date"
            aria-label="开始日期"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-36"
          />
          <span className="text-sm text-muted-foreground">至</span>
          <Input
            type="date"
            aria-label="结束日期"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-36"
          />
          <Button type="submit" size="sm" className="h-9" disabled={!from || !to || invalid}>
            应用
          </Button>
          {invalid && <span className="text-xs text-destructive">开始日期不能晚于结束日期</span>}
        </>
      )}
    </form>
  );
}
