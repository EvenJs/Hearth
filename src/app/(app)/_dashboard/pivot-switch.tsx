import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { dashboardHref } from '@/lib/dashboard/format';
import type { DashboardScope } from '@/lib/dashboard/links';
import type { PivotView } from '@/lib/dashboard/pivot-view';

// R10.2 汇总表的三个切换：按周 / 按月、按分类 / 按归属人、支出 / 收入
// 每个按钮就是一个链接，写进 URL；时间段、归属人筛选和另外两个切换不变

type Props = { scope: DashboardScope; view: PivotView };

const GROUPS = [
  {
    key: 'granularity',
    label: '粒度',
    options: [
      { value: 'week', label: '按周' },
      { value: 'month', label: '按月' },
    ],
  },
  {
    key: 'groupBy',
    label: '分组',
    options: [
      { value: 'category', label: '按分类' },
      { value: 'member', label: '按归属人' },
    ],
  },
  {
    key: 'metric',
    label: '指标',
    options: [
      { value: 'expense', label: '支出' },
      { value: 'income', label: '收入' },
    ],
  },
] as const;

export function PivotSwitch({ scope, view }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {GROUPS.map((g) => (
        <nav key={g.key} aria-label={g.label} className="flex gap-1 rounded-lg border bg-card p-1">
          {g.options.map((o) => {
            const active = view[g.key] === o.value;
            return (
              <Button
                key={o.value}
                asChild
                size="sm"
                variant={active ? 'default' : 'ghost'}
                className="h-7 px-3"
              >
                <Link
                  href={dashboardHref(scope, { ...view, [g.key]: o.value })}
                  aria-current={active ? 'page' : undefined}
                  scroll={false}
                >
                  {o.label}
                </Link>
              </Button>
            );
          })}
        </nav>
      ))}
    </div>
  );
}
