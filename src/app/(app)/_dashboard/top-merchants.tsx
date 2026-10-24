import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { merchantLink, type DashboardScope } from '@/lib/dashboard/links';
import { formatAud } from '@/lib/rules/money';
import type { Dashboard } from '@/server/dashboard';
import { transactionsHref } from '../transactions/href';

// F6 支出 Top 商家（R10.3）：按笔数排（笔数一样按金额、再按名字），前 5 个，显示商家名、笔数、金额
// 排序在 topMerchants 里做好了，这里照顺序显示。点商家跳 F8（商家关键词 + 支出类型）

type Props = { dashboard: Dashboard; scope: DashboardScope };

export function TopMerchants({ dashboard, scope }: Props) {
  const merchants = dashboard.topMerchants;
  return (
    <Card className="min-w-0 gap-3 p-4 lg:p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold">支出 Top 商家</h2>
        <span className="text-xs text-muted-foreground">按笔数</span>
      </div>
      {merchants.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">这段时间没有支出</p>
      ) : (
        <ol className="flex flex-col">
          {merchants.map((m, i) => (
            <li key={m.merchant}>
              <Link
                href={transactionsHref(merchantLink(scope, m.merchant))}
                className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/60"
              >
                <span className="w-4 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium underline-offset-4 group-hover:underline">
                    {m.merchant}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">{m.count} 笔</span>
                </span>
                <span className="shrink-0 text-sm tabular-nums">{formatAud(m.cents)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
