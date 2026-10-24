import { Card } from '@/components/ui/card';
import {
  expenseShare,
  expenseShareBase,
  expenseSubLines,
  formatShare,
} from '@/lib/dashboard/format';
import { categoryLink, type DashboardScope } from '@/lib/dashboard/links';
import { formatAud } from '@/lib/rules/money';
import type { CategoryTone } from '@/lib/transactions/category-color';
import type { Dashboard } from '@/server/dashboard';
import { transactionsHref } from '../transactions/href';
import { toneOfTop } from '../transactions/tx-badges';
import { CategoryList, type CategoryRow } from './category-list';

// F6 支出分类（R10 分类支出，设计图 02）：一级列表，点箭头展开二级
// 二级汇总到一级；退款直接冲减，负数照实显示。占比按正数支出合计算，负数行没有占比、不画条
// 固定按金额从大到小（summarize 的顺序），系统分类（现金支出、银行费用）没有二级，不显示箭头
// 有二级的一级点了只展开收起，不跳 F8（2026-10-24 改）；二级、没有二级的一级（现金支出、银行费用）点进 F8（categoryLink）
// 钱直接记在一级上时，展开后多一行"X（不细分）"（expenseSubLines）。这一行不能点：
// F8 选一级会带上所有二级，没法只筛一级本身，点过去合计对不上

type Props = { dashboard: Dashboard; scope: DashboardScope };

export function ExpenseCategories({ dashboard, scope }: Props) {
  const { current, categories } = dashboard;
  const totals = current.expenseByCategory;
  const base = expenseShareBase(totals);
  const href = (id: string) => transactionsHref(categoryLink(scope, id));
  const nameOf = (id: string) => categories[id]?.nameEn ?? '（分类已删除）';

  const rows: CategoryRow[] = totals.map((t) => {
    const top = categories[t.categoryId];
    const tone: CategoryTone = top
      ? toneOfTop({ id: top.id, nameEn: top.nameEn, kind: top.kind, systemKey: top.systemKey })
      : 'system';
    const share = expenseShare(t.cents, base);
    return {
      id: t.categoryId,
      name: nameOf(t.categoryId),
      tone,
      amount: formatAud(t.cents),
      negative: t.cents < 0,
      share,
      shareText: formatShare(share),
      href: href(t.categoryId),
      children: expenseSubLines(t).map((c) => {
        const childShare = expenseShare(c.cents, base);
        return {
          id: c.unsplit ? `${c.categoryId}-unsplit` : c.categoryId,
          name: c.unsplit ? `${nameOf(c.categoryId)}（不细分）` : nameOf(c.categoryId),
          amount: formatAud(c.cents),
          negative: c.cents < 0,
          share: childShare,
          shareText: formatShare(childShare),
          href: c.unsplit ? null : href(c.categoryId),
        };
      }),
    };
  });

  return (
    <Card className="min-w-0 gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">支出分类</h2>
        <p className="text-sm text-muted-foreground">
          合计{' '}
          <span className="font-medium text-foreground tabular-nums">
            {formatAud(current.expenseCents)}
          </span>
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">这段时间没有支出</p>
      ) : (
        <CategoryList rows={rows} />
      )}
    </Card>
  );
}
