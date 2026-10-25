// 看板的显示格式和看板自己的 URL（prd.md F6、business-rules.md R10、R10.4）
// 金额用 formatAud（money.ts），这里只管百分比、时间段文字和链接
// 纯函数，不 import 数据库和 Next.js
import type { DateRange, Period, PresetPeriod } from '@/lib/rules/periods';
import { filtersToSearchParams } from '@/lib/transactions/filters';
import type { DashboardScope } from './links';
import { pivotViewToSearchParams, type PivotView } from './pivot-view';

// R10.1 时间段选项的中文名；F8 筛选栏也用
export const PERIOD_LABELS: Record<PresetPeriod, string> = {
  this_week: '本周',
  last_week: '上周',
  this_month: '本月',
  last_month: '上月',
  this_quarter: '本季度',
  this_year: '今年',
  this_fy: '本财年',
};

export const DEFAULT_PERIOD: PresetPeriod = 'this_month'; // prd.md F6：本月（默认）

const DASH = '—';

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

// R10.4：收入、支出的百分比变化，已经是整数；不能比时 null
export function formatPercentChange(percent: number | null): string {
  return percent === null ? DASH : `${signed(percent)}%`;
}

// R10.4：储蓄率的百分点差
export function formatPointsChange(points: number | null): string {
  return points === null ? DASH : `${signed(points)} pp`;
}

// R10：储蓄率取整到百分比，按绝对值舍入再带上符号（和 R10.4 一致）；收入 ≤ 0 时 null
export function formatSavingsRate(rate: number | null): string {
  if (rate === null) return DASH;
  const whole = Math.round(Math.abs(rate) * 100);
  return `${rate < 0 && whole !== 0 ? '-' : ''}${whole}%`;
}

// "2026-09-01" → "9月1日"；不是今年的带年份
function formatDay(date: string, today: string): string {
  const [y, m, d] = date.split('-');
  const md = `${Number(m)}月${Number(d)}日`;
  return y === today.slice(0, 4) ? md : `${y}年${md}`;
}

// 时间段显示：首尾都是今年时不带年份；同一天只显示一次
export function formatRange(range: DateRange, today: string): string {
  if (range.start === range.end) return formatDay(range.start, today);
  const sameYear =
    range.start.slice(0, 4) === today.slice(0, 4) && range.end.slice(0, 4) === today.slice(0, 4);
  const fmt = (d: string) => (sameYear ? formatDay(d, today) : formatDay(d, '0000-00-00'));
  return `${fmt(range.start)} – ${fmt(range.end)}`;
}

// 看板 URL：参数写法和 F8 一样（period 或 from/to、member），默认的本月不写进 URL
// 汇总表的切换（M5-5）跟在后面，默认值不写；换时间段、归属人时把当前的切换带上，不丢
export function dashboardHref(scope: DashboardScope, view?: PivotView): string {
  const period: Period = scope.period;
  const p = filtersToSearchParams({
    period:
      period.option === 'custom'
        ? { start: period.start, end: period.end }
        : period.option === DEFAULT_PERIOD
          ? undefined
          : period.option,
    memberId: scope.memberId,
  });
  if (view) pivotViewToSearchParams(view, p);
  const qs = p.toString();
  return qs ? `/?${qs}` : '/';
}

// ---------- R10 分类支出占比（M5-4） ----------

// 分母 = 正数行的合计。负数行（退款大于支出，如 Personal & medical -45.80）照实显示，但不拿来冲减分母
// 传一级的合计；二级的占比也用同一个分母，和一级放在一起比
export function expenseShareBase(rows: readonly { cents: number }[]): number {
  return rows.reduce((sum, r) => (r.cents > 0 ? sum + r.cents : sum), 0);
}

// 0 到 1；负数行、没有正数支出时没有占比（null），界面上不画条
export function expenseShare(cents: number, base: number): number | null {
  if (cents < 0 || base <= 0) return null;
  return cents / base;
}

// 一位小数，"34.5%"；没有占比时"—"
export function formatShare(share: number | null): string {
  return share === null ? DASH : `${(share * 100).toFixed(1)}%`;
}

export type ExpenseSubLine = { categoryId: string; cents: number; unsplit: boolean };

// 展开一级后的各行：二级，加上直接记在一级上的部分（unsplit，显示成"X（不细分）"），按金额从大到小
// 没有二级（系统分类，或者钱全记在一级上）时返回空，不显示箭头；一级部分是 0 时不加这一行
export function expenseSubLines(top: {
  categoryId: string;
  cents: number;
  children: readonly { categoryId: string; cents: number }[];
}): ExpenseSubLine[] {
  if (top.children.length === 0) return [];
  const lines: ExpenseSubLine[] = top.children.map((c) => ({ ...c, unsplit: false }));
  const rest = top.cents - top.children.reduce((sum, c) => sum + c.cents, 0);
  if (rest !== 0) lines.push({ categoryId: top.categoryId, cents: rest, unsplit: true });
  return lines.sort((a, b) => b.cents - a.cents);
}
