import { Card } from '@/components/ui/card';
import type { DashboardScope } from '@/lib/dashboard/links';
import { pivotColumnLabel, pivotSubRows, type PivotView } from '@/lib/dashboard/pivot-view';
import { formatAud } from '@/lib/rules/money';
import type { CategoryTone } from '@/lib/transactions/category-color';
import type { getPivot } from '@/server/dashboard';
import { toneOfTop } from '../transactions/tx-badges';
import { PivotSwitch } from './pivot-switch';
import { PivotTable, type PivotCellView, type PivotRowView } from './pivot-table';

// F6 汇总表（R10.2，设计图 02）：时间段按周或按月切开，再按一级分类或归属人分组
// 表头标"部分"，行合计、列合计加粗；按分类时一级可展开二级（展开后同 M5-4，多一行"X（不细分）"）
// 格子不跳 F8（2026-10-25 改）：按分类时点一级那一行展开收起二级，其他行点了没反应
// R10.6：选了归属人时，数据只剩这个归属人的拆分

type Props = {
  data: Awaited<ReturnType<typeof getPivot>>;
  scope: DashboardScope;
  view: PivotView;
  members: { id: string; name: string }[];
  today: string;
};

export function PivotSection({ data, scope, view, members, today }: Props) {
  const { pivot, categories } = data;
  const { groupBy, metric } = view;

  // 每列一格，最后一格是行合计
  const cellsOf = (cells: number[], total: number): PivotCellView[] =>
    [...cells, total].map((cents) => ({ text: formatAud(cents), zero: cents === 0 }));

  const nameOf = (key: string) =>
    groupBy === 'member'
      ? (members.find((m) => m.id === key)?.name ?? '（归属人已删除）')
      : (categories[key]?.nameEn ?? '（分类已删除）');

  const rows: PivotRowView[] = pivot.rows.map((r) => {
    const top = categories[r.key];
    const tone: CategoryTone | null =
      groupBy === 'category' && top
        ? toneOfTop({ id: top.id, nameEn: top.nameEn, kind: top.kind, systemKey: top.systemKey })
        : null;
    return {
      id: r.key,
      name: nameOf(r.key),
      tone,
      cells: cellsOf(r.cells, r.total),
      children: pivotSubRows(r).map((c) => ({
        id: c.unsplit ? `${c.key}-unsplit` : c.key,
        name: c.unsplit ? `${nameOf(c.key)}（不细分）` : nameOf(c.key),
        cells: cellsOf(c.cells, c.total),
      })),
    };
  });

  return (
    <Card className="min-w-0 gap-4 p-4 lg:p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="text-lg font-semibold">汇总表</h2>
        <PivotSwitch scope={scope} view={view} />
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          这段时间没有{metric === 'expense' ? '支出' : '收入'}
        </p>
      ) : (
        <PivotTable
          firstHeader={groupBy === 'category' ? '分类' : '归属人'}
          columns={pivot.columns.map((c) => ({
            label: pivotColumnLabel(c, view.granularity, today),
            partial: c.partial,
          }))}
          rows={rows}
          totals={cellsOf(pivot.columnTotals, pivot.total)}
        />
      )}
    </Card>
  );
}
