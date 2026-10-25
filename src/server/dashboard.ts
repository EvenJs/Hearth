// F6 看板的数据层（M5-2）：按 household_id 把拆分查出来，串 src/lib/rules/ 的纯函数
// 统计口径全在 stats.ts、periods.ts 里，这里不在 SQL 里算业务口径（docs/tasks/m5.md 通用要求）
// pending 的交易照常查出来（R10、R10.6）；归属人筛选用 filterByMember，不放进 SQL
import { and, eq, gte, lte } from 'drizzle-orm';
import { db } from '@/db';
import { category, transaction, transactionSplit } from '@/db/schema';
import {
  lastTwelveMonths,
  periodRange,
  previousPeriod,
  type DateRange,
  type Period,
  type PresetPeriod,
} from '@/lib/rules/periods';
import {
  compare,
  filterByMember,
  monthlyTrend,
  pendingCount,
  pivot,
  summarize,
  topMerchants,
  type Comparison,
  type GroupBy,
  type Granularity,
  type MerchantSplit,
  type MerchantTotal,
  type Metric,
  type MonthTrend,
  type PendingSplit,
  type Pivot,
  type Summary,
} from '@/lib/rules/stats';
import type { Category } from '@/lib/rules/types';
import type { HouseholdContext } from './context';

const TOP_MERCHANTS = 5; // R10.3 显示前 5 个

// 看板要的拆分字段：统计（StatSplit）+ Top 商家 + pending
type DashboardSplit = MerchantSplit & PendingSplit;

// ---------- 查询 ----------

// 本家庭的全部分类，含已归档的：老拆分可能还指向归档的分类，少了 summarize 会报"找不到分类"
async function loadCategories(ctx: HouseholdContext): Promise<Category[]> {
  return db
    .select({
      id: category.id,
      parentId: category.parentId,
      nameEn: category.nameEn,
      kind: category.kind,
      systemKey: category.systemKey,
      defaultMemberId: category.defaultMemberId,
      isPreTaxDefault: category.isPreTaxDefault,
      isOther: category.isOther,
    })
    .from(category)
    .where(eq(category.householdId, ctx.householdId));
}

// 交易日期在 range 内（含首尾）的所有拆分，pending 也算
async function loadSplits(ctx: HouseholdContext, range: DateRange): Promise<DashboardSplit[]> {
  return db
    .select({
      transactionId: transactionSplit.transactionId,
      date: transaction.date,
      merchant: transaction.merchant,
      status: transaction.status,
      amountCents: transactionSplit.amountCents,
      categoryId: transactionSplit.categoryId,
      memberId: transactionSplit.memberId,
      isPreTax: transactionSplit.isPreTax,
    })
    .from(transactionSplit)
    .innerJoin(
      transaction,
      and(
        eq(transaction.id, transactionSplit.transactionId),
        eq(transaction.householdId, ctx.householdId),
      ),
    )
    .where(
      and(
        eq(transactionSplit.householdId, ctx.householdId),
        gte(transaction.date, range.start),
        lte(transaction.date, range.end),
      ),
    );
}

// 几段时间合在一起的最小范围，只查一次库
function cover(ranges: DateRange[]): DateRange {
  return {
    start: ranges.reduce((a, r) => (r.start < a ? r.start : a), ranges[0].start),
    end: ranges.reduce((a, r) => (r.end > a ? r.end : a), ranges[0].end),
  };
}

// ---------- getDashboard ----------

export type DashboardInput = {
  period: PresetPeriod | DateRange; // R10.1；和 F8 筛选的 period 一样
  memberId?: string; // R10.6；不传 = 全部
};

// 看板显示分类要的字段（M5-4）：名字、颜色（按一级的名字和类型取）
export type DashboardCategory = Pick<Category, 'id' | 'parentId' | 'nameEn' | 'kind' | 'systemKey'>;

export type Dashboard = {
  period: Period;
  previous: DateRange; // R10.1 上一个同长度时间段
  current: Summary;
  previousSummary: Summary;
  comparison: Comparison; // R10.4
  topMerchants: MerchantTotal[]; // R10.3，前 5 个
  pendingCount: number; // R10.6 "含 N 笔待确认交易"
  trend: MonthTrend[]; // R10.5，固定近 12 个月，不跟时间段走
  // 本期支出分类里出现的一级、二级，按 id 查。从全部分类里取（含已归档），老拆分指向归档分类也有名字
  categories: Record<string, DashboardCategory>;
};

// 从全部分类（含已归档）里挑出要显示的那几个，老拆分指向归档分类也有名字
function pickCategories(
  categories: readonly Category[],
  ids: ReadonlySet<string>,
): Record<string, DashboardCategory> {
  const out: Record<string, DashboardCategory> = {};
  for (const c of categories) {
    if (ids.has(c.id)) {
      out[c.id] = {
        id: c.id,
        parentId: c.parentId,
        nameEn: c.nameEn,
        kind: c.kind,
        systemKey: c.systemKey,
      };
    }
  }
  return out;
}

export async function getDashboard(
  ctx: HouseholdContext,
  input: DashboardInput,
  today: string,
): Promise<Dashboard> {
  const period = periodRange(input.period, today);
  const previous = previousPeriod(period);
  const months = lastTwelveMonths(today);

  const [categories, all] = await Promise.all([
    loadCategories(ctx),
    loadSplits(ctx, cover([period, previous, ...months])),
  ]);
  const splits = filterByMember(all, input.memberId);

  const current = summarize(splits, categories, period);
  const previousSummary = summarize(splits, categories, previous);

  return {
    period,
    previous,
    current,
    previousSummary,
    comparison: compare(current, previousSummary),
    topMerchants: topMerchants(splits, categories, period, TOP_MERCHANTS),
    pendingCount: pendingCount(splits, period),
    trend: monthlyTrend(splits, categories, months),
    categories: pickCategories(
      categories,
      new Set(
        current.expenseByCategory.flatMap((t) => [
          t.categoryId,
          ...t.children.map((c) => c.categoryId),
        ]),
      ),
    ),
  };
}

// ---------- getPivot ----------

export type PivotInput = DashboardInput & {
  granularity: Granularity;
  groupBy: GroupBy;
  metric: Metric;
};

// R10.2 汇总表；R10.6 按归属人分组时也照样过滤，只剩一行
export async function getPivot(
  ctx: HouseholdContext,
  input: PivotInput,
  today: string,
): Promise<{ period: Period; pivot: Pivot; categories: Record<string, DashboardCategory> }> {
  const period = periodRange(input.period, today);
  const [categories, all] = await Promise.all([loadCategories(ctx), loadSplits(ctx, period)]);
  const splits = filterByMember(all, input.memberId);
  const table = pivot(splits, categories, period, input.granularity, input.groupBy, input.metric);
  return {
    period,
    pivot: table,
    // 按分类分组时行名要用（M5-5）；按归属人分组时是空的
    categories:
      input.groupBy === 'category'
        ? pickCategories(
            categories,
            new Set(table.rows.flatMap((r) => [r.key, ...r.children.map((c) => c.key)])),
          )
        : {},
  };
}
