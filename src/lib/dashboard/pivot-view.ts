// 看板汇总表（R10.2）的切换和显示：URL 参数、列标题、展开后的二级行
// 纯函数，不 import 数据库和 Next.js
import type { GroupBy, Granularity, Metric, PivotColumn, PivotRow } from '@/lib/rules/stats';
import type { SearchParamsInput } from '@/lib/transactions/filters';

// 三个切换：按周 / 按月、按分类 / 按归属人、支出 / 收入
export type PivotView = { granularity: Granularity; groupBy: GroupBy; metric: Metric };

// 默认：按周、按分类、支出（R10.2 支出是默认）。默认值不写进 URL
export const DEFAULT_PIVOT_VIEW: PivotView = {
  granularity: 'week',
  groupBy: 'category',
  metric: 'expense',
};

// URL 参数名，不和 F8 的筛选参数（period、from、to、member、category、type…）撞
const KEYS = { granularity: 'grain', groupBy: 'group', metric: 'metric' } as const;
const OPTIONS = {
  granularity: ['week', 'month'],
  groupBy: ['category', 'member'],
  metric: ['expense', 'income'],
} as const;

function first(params: SearchParamsInput, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

function pick<K extends keyof PivotView>(params: SearchParamsInput, k: K): PivotView[K] {
  const v = first(params, KEYS[k]);
  return (OPTIONS[k] as readonly string[]).includes(v ?? '')
    ? (v as PivotView[K])
    : DEFAULT_PIVOT_VIEW[k];
}

// 每个参数单独判断，不合法的回到默认
export function pivotViewFromSearchParams(params: SearchParamsInput): PivotView {
  return {
    granularity: pick(params, 'granularity'),
    groupBy: pick(params, 'groupBy'),
    metric: pick(params, 'metric'),
  };
}

// 写进 URL：只写和默认不一样的
export function pivotViewToSearchParams(view: PivotView, p = new URLSearchParams()) {
  for (const k of Object.keys(KEYS) as (keyof PivotView)[]) {
    if (view[k] !== DEFAULT_PIVOT_VIEW[k]) p.set(KEYS[k], view[k]);
  }
  return p;
}

// "2026-09-01" → "9/1"
function md(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

// 列标题："部分"由界面另外标。按周 9/1–9/6；按月 9月，不是今年的带年份
export function pivotColumnLabel(
  col: PivotColumn,
  granularity: Granularity,
  today: string,
): string {
  if (granularity === 'week') {
    return col.start === col.end ? md(col.start) : `${md(col.start)}–${md(col.end)}`;
  }
  const [y, m] = col.start.split('-');
  return y === today.slice(0, 4) ? `${Number(m)}月` : `${y}年${Number(m)}月`;
}

export type PivotSubRow = PivotRow & { unsplit: boolean };

// 展开一级后的各行：二级，加上直接记在一级上的部分（unsplit，显示成"X（不细分）"），按行合计从大到小
// 和 M5-4 支出分类的 expenseSubLines 一样；每列都对得上（全是 0）时不加这一行
export function pivotSubRows(top: PivotRow): PivotSubRow[] {
  if (top.children.length === 0) return [];
  const rows: PivotSubRow[] = top.children.map((c) => ({ ...c, unsplit: false }));
  const cells = top.cells.map(
    (cents, i) => cents - top.children.reduce((sum, c) => sum + c.cells[i], 0),
  );
  if (cells.some((c) => c !== 0)) {
    const total = cells.reduce((a, c) => a + c, 0);
    rows.push({ key: top.key, cells, total, children: [], unsplit: true });
  }
  return rows.sort((a, b) => b.total - a.total);
}
