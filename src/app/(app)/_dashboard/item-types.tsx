import { Card } from '@/components/ui/card';
import { pivotColumnLabel } from '@/lib/dashboard/pivot-view';
import { ITEM_TYPES } from '@/lib/rules/item-type';
import type { ItemTypeKey } from '@/lib/rules/item-type-stats';
import { formatAud } from '@/lib/rules/money';
import type { ItemTypeStats } from '@/server/item-types';
import { PivotTable, type PivotCellView, type PivotRowView } from './pivot-table';

// F6 商品类型统计（R21.7，M7.6-7）：拍了小票、挂上了交易的部分，按 receipt_date 的月份 × 商品类型
// 月份跟看板时间段走，首尾不满一个月的表头标"部分"；不跟归属人（类型不在拆分上），标"全家"
// 表格复用汇总表的 PivotTable，没有二级，点了没反应。"未分"是旧小票没类型的件，排最后

type Props = { stats: ItemTypeStats; today: string };

const LABELS: Record<ItemTypeKey, string> = {
  ...(Object.fromEntries(ITEM_TYPES.map((t) => [t.key, t.label])) as Record<
    Exclude<ItemTypeKey, 'untyped'>,
    string
  >),
  untyped: '未分',
};

export function ItemTypes({ stats, today }: Props) {
  // 每列一格，最后一格是行合计
  const cellsOf = (cells: number[], total: number): PivotCellView[] =>
    [...cells, total].map((cents) => ({ text: formatAud(cents), zero: cents === 0 }));

  const rows: PivotRowView[] = stats.rows.map((r) => ({
    id: r.type,
    name: LABELS[r.type],
    tone: null,
    cells: cellsOf(r.cells, r.total),
    children: [],
  }));

  return (
    <Card className="min-w-0 gap-4 p-4 lg:p-6">
      <div className="flex flex-col gap-1 lg:flex-row lg:items-baseline lg:justify-between lg:gap-4">
        <h2 className="text-lg font-semibold">商品类型</h2>
        <span className="text-xs text-muted-foreground">
          只统计拍了小票的部分 · 全家 · 按小票日期
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">这段时间没有拍小票</p>
      ) : (
        <PivotTable
          firstHeader="类型"
          columns={stats.columns.map((c) => ({
            label: pivotColumnLabel(c, 'month', today),
            partial: c.partial,
          }))}
          rows={rows}
          totals={cellsOf(stats.columnTotals, stats.total)}
        />
      )}
    </Card>
  );
}
