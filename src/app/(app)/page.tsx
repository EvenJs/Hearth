import { connection } from 'next/server';
import { Suspense } from 'react';
import { formatRange, DEFAULT_PERIOD } from '@/lib/dashboard/format';
import { pivotViewFromSearchParams } from '@/lib/dashboard/pivot-view';
import type { DashboardScope } from '@/lib/dashboard/links';
import { todayInMelbourne } from '@/lib/rules/periods';
import { filtersFromSearchParams } from '@/lib/transactions/filters';
import { listBudgetsWithProgress } from '@/server/budgets';
import { getHouseholdContext } from '@/server/context';
import { getDashboard, getPivot } from '@/server/dashboard';
import { listMembers } from '@/server/members';
import { ExpenseCategories } from './_dashboard/expense-categories';
import { KpiCards, PendingNote } from './_dashboard/kpi-cards';
import { MemberSwitch } from './_dashboard/member-switch';
import { PeriodPicker } from './_dashboard/period-picker';
import { PinnedBudgets } from './_dashboard/pinned-budgets';
import { PivotSection } from './_dashboard/pivot-section';
import { TopMerchants } from './_dashboard/top-merchants';

// F6 看板（设计图 02，M5-3）：时间段和归属人在 URL 参数里，写法和 F8 一样（period 或 from/to、member）
// 没有参数 = 本月、全部归属人。不合法的参数丢掉（filtersFromSearchParams）
// 分类占比和 Top 商家（M5-4）；汇总表（M5-5，切换写在 URL 的 grain、group、metric）；趋势（M5-6）后面加
// 顶部置顶预算（M7-4，R11.3）固定本月、全家，不跟筛选；税务卡片在 M7-6
export default function HomePage(props: PageProps<'/'>) {
  return (
    // 读 session 和 searchParams 的部分放在 Suspense 里（cacheComponents）
    <Suspense
      fallback={
        <>
          <h1 className="text-2xl font-semibold">看板</h1>
          <p className="text-sm text-muted-foreground">加载中…</p>
        </>
      }
    >
      <DashboardSection searchParams={props.searchParams} />
    </Suspense>
  );
}

async function DashboardSection({
  searchParams,
}: {
  searchParams: PageProps<'/'>['searchParams'];
}) {
  const params = await searchParams;
  const filters = filtersFromSearchParams(params);
  const view = pivotViewFromSearchParams(params);
  const ctx = await getHouseholdContext();
  // "今天"每次请求都要重新算，不能被预渲染
  await connection();
  const today = todayInMelbourne();

  const members = (await listMembers(ctx)).map(({ id, name }) => ({ id, name }));
  // 不是本家庭的归属人 id 当作没选
  const memberId = members.some((m) => m.id === filters.memberId) ? filters.memberId : undefined;
  const input = { period: filters.period ?? DEFAULT_PERIOD, memberId };
  const [dashboard, pivotData, budgets] = await Promise.all([
    getDashboard(ctx, input, today),
    getPivot(ctx, { ...input, ...view }, today),
    // R11.3：不传时间段和归属人
    listBudgetsWithProgress(ctx, today),
  ]);
  const scope: DashboardScope = { period: dashboard.period, memberId };

  return (
    <>
      {/* 时间段和归属人只放一组，在标题旁边（design/README 第 4 节） */}
      <header className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold">看板</h1>
          <span className="text-sm text-muted-foreground tabular-nums">
            {formatRange(dashboard.period, today)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PeriodPicker period={dashboard.period} memberId={memberId} view={view} today={today} />
          <MemberSwitch
            period={dashboard.period}
            memberId={memberId}
            view={view}
            members={members}
          />
        </div>
      </header>

      <PinnedBudgets
        budgets={budgets.budgets}
        overview={budgets.overview}
        memberSelected={memberId !== undefined}
      />

      <div className="flex flex-col gap-3">
        <KpiCards dashboard={dashboard} scope={scope} today={today} />
        <PendingNote count={dashboard.pendingCount} scope={scope} />
      </div>

      {/* 设计图 02：左边宽的是支出分类，右边 Top 商家（税务卡片在 M7，不留占位） */}
      <div className="grid gap-3 lg:grid-cols-3 lg:gap-4">
        <div className="min-w-0 lg:col-span-2">
          <ExpenseCategories dashboard={dashboard} scope={scope} />
        </div>
        <div className="min-w-0">
          <TopMerchants dashboard={dashboard} scope={scope} />
        </div>
      </div>

      <PivotSection data={pivotData} scope={scope} view={view} members={members} today={today} />
    </>
  );
}
