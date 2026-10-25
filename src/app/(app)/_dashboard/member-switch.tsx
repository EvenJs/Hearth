import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { dashboardHref } from '@/lib/dashboard/format';
import type { PivotView } from '@/lib/dashboard/pivot-view';
import type { Period } from '@/lib/rules/periods';

// R10.6 看板归属人分段切换：全部 / 各归属人。每个按钮就是一个链接，切换写进 URL，时间段不变
type Props = {
  period: Period;
  memberId?: string;
  view?: PivotView; // 汇总表当前的切换，换归属人时带上不丢（M5-5）
  members: { id: string; name: string }[];
};

export function MemberSwitch({ period, memberId, view, members }: Props) {
  const options = [{ id: undefined, name: '全部' }, ...members];
  return (
    <nav aria-label="归属人" className="flex flex-wrap gap-1 rounded-lg border bg-card p-1">
      {options.map((m) => {
        const active = m.id === memberId;
        return (
          <Button
            key={m.id ?? 'all'}
            asChild
            size="sm"
            variant={active ? 'default' : 'ghost'}
            className="h-7 px-3"
          >
            <Link
              href={dashboardHref({ period, memberId: m.id }, view)}
              aria-current={active ? 'page' : undefined}
              scroll={false}
            >
              {m.name}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
}
