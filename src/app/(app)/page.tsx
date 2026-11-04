import { connection } from 'next/server';
import { Suspense } from 'react';
import { formatRange, DEFAULT_PERIOD } from '@/lib/dashboard/format';
import { pivotViewFromSearchParams } from '@/lib/dashboard/pivot-view';
import type { DashboardScope } from '@/lib/dashboard/links';
import { spendableAfterGoals } from '@/lib/rules/budget';
import { periodRange, todayInMelbourne } from '@/lib/rules/periods';
import { financialYearOf } from '@/lib/tax/estimate';
import { filtersFromSearchParams } from '@/lib/transactions/filters';
import { listBudgetsWithProgress } from '@/server/budgets';
import { getConditionReminder } from '@/server/conditions';
import { getHouseholdContext } from '@/server/context';
import { getDashboard, getPivot } from '@/server/dashboard';
import { getHomeGoals } from '@/server/goals';
import { getItemTypeStats } from '@/server/item-types';
import { listMembers } from '@/server/members';
import { getMonthlyAverage } from '@/server/monthly-average';
import { getHouseholdTax } from '@/server/tax';
import { ConditionReminder } from './_dashboard/condition-reminder';
import { ExpenseCategories } from './_dashboard/expense-categories';
import { ItemTypes } from './_dashboard/item-types';
import { KpiCards, PendingNote } from './_dashboard/kpi-cards';
import { MemberSwitch } from './_dashboard/member-switch';
import { MonthlyAverage } from './_dashboard/monthly-average';
import { PeriodPicker } from './_dashboard/period-picker';
import { PinnedBudgets } from './_dashboard/pinned-budgets';
import { PinnedGoals } from './_dashboard/pinned-goals';
import { PivotSection } from './_dashboard/pivot-section';
import { TaxCards } from './_dashboard/tax-cards';
import { TopMerchants } from './_dashboard/top-merchants';

// F6 看板（设计图 02，M5-3）：时间段和归属人在 URL 参数里，写法和 F8 一样（period 或 from/to、member）
// 没有参数 = 本月、全部归属人。不合法的参数丢掉（filtersFromSearchParams）
// 分类占比和 Top 商家（M5-4）；汇总表（M5-5，切换写在 URL 的 grain、group、metric）；趋势（M5-6）后面加
// 顶部置顶预算（M7-4，R11.3）固定本月、全家，不跟筛选；税务卡片（M7-6，R14.6）固定今天所在的财年
// 商品类型统计（M7.6-7，R21.7）跟时间段、不跟归属人，放在汇总表下面
// 月均卡片（M7.7-7，R22.8）跟归属人、不跟时间段，放在汇总表上面；KPI 支出下面"其中一次性"（R22.10）
// 每月条件提示（M10-7，R24.9）一行放在最上面，只在本月最后几天出现，不跟筛选
// 预算那一行加"还能花（已扣目标）"（M11-7，R25.10）；固定目标（R25.11）放在置顶预算下面，不跟筛选
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

  // 带 kind：税务卡片要分清选的是不是 person（R14.6）
  const allMembers = await listMembers(ctx);
  const members = allMembers.map(({ id, name }) => ({ id, name }));
  // 不是本家庭的归属人 id 当作没选
  const memberId = members.some((m) => m.id === filters.memberId) ? filters.memberId : undefined;
  const input = { period: filters.period ?? DEFAULT_PERIOD, memberId };
  const period = periodRange(input.period, today);
  const [
    dashboard,
    pivotData,
    budgets,
    tax,
    itemTypeStats,
    monthlyAverage,
    conditionReminder,
    homeGoals,
  ] = await Promise.all([
    getDashboard(ctx, input, today),
    getPivot(ctx, { ...input, ...view }, today),
    // R11.3：不传时间段和归属人
    listBudgetsWithProgress(ctx, today),
    // R14.6：不跟时间段
    getHouseholdTax(ctx, financialYearOf(today)),
    // R21.7：全家，不传归属人
    getItemTypeStats(ctx, period),
    // R22.8：跟归属人，不跟时间段
    getMonthlyAverage(ctx, today, memberId),
    // R24.9：不跟时间段和归属人
    getConditionReminder(ctx, today),
    // R25.10、R25.11：不跟时间段和归属人
    getHomeGoals(ctx, today),
  ]);
  const spendable = spendableAfterGoals(budgets.overview, homeGoals.goalsCents);
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

      <ConditionReminder reminder={conditionReminder} />

      <PinnedBudgets
        budgets={budgets.budgets}
        overview={budgets.overview}
        spendable={spendable}
        memberSelected={memberId !== undefined}
      />

      <PinnedGoals goals={homeGoals.pinned} memberSelected={memberId !== undefined} />

      <div className="flex flex-col gap-3">
        <KpiCards dashboard={dashboard} scope={scope} today={today} />
        <PendingNote count={dashboard.pendingCount} scope={scope} />
      </div>

      {/* 设计图 02 把税务卡片放在右栏 Top 商家上面，右栏会比支出分类高很多、左边留大片空白，
          所以单独一行放在支出分类上面 */}
      <TaxCards tax={tax} memberId={memberId} members={allMembers} />

      {/* 设计图 02：左边宽的是支出分类，右边 Top 商家 */}
      <div className="grid gap-3 lg:grid-cols-3 lg:gap-4">
        <div className="min-w-0 lg:col-span-2">
          <ExpenseCategories dashboard={dashboard} scope={scope} />
        </div>
        <div className="min-w-0">
          <TopMerchants dashboard={dashboard} scope={scope} />
        </div>
      </div>

      {/* R22.8：月均卡片放在汇总表上面 */}
      <MonthlyAverage data={monthlyAverage} />

      <PivotSection data={pivotData} scope={scope} view={view} members={members} today={today} />

      <ItemTypes stats={itemTypeStats} today={today} />
    </>
  );
}
