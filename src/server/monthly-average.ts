// 看板月均卡片的数据层（M7.7-7，business-rules.md R22.5 到 R22.9）
// 口径和取整全在 src/lib/rules/monthly-average.ts，这里只查数据、把两个窗口和本月拼成表格行
// R22.8：跟归属人筛选（filterByMember），不跟时间段，窗口永远按今天算
import { and, eq, gte, lte, min } from 'drizzle-orm';
import { db } from '@/db';
import { category, member, transaction, transactionSplit } from '@/db/schema';
import { expenseSubLines } from '@/lib/dashboard/format';
import {
  averageWindow,
  compareToAverage,
  monthlyAverage,
  type AverageSplit,
  type AverageWindow,
  type MonthlyAverage,
} from '@/lib/rules/monthly-average';
import { startOfMonth } from '@/lib/rules/periods';
import { filterByMember } from '@/lib/rules/stats';
import type { Category, Member } from '@/lib/rules/types';
import type { HouseholdContext } from './context';
import type { DashboardCategory } from './dashboard';

// 一行的 4 格：近 12 月均、近 3 月均、本月（排除一次性）、本月对比近 12 月均（R22.9，null 显示"—"）
export type AverageCells = {
  avg12Cents: number;
  avg3Cents: number;
  currentCents: number;
  percent: number | null;
};

// 二级；unsplit = 直接记在一级上的部分，显示成"X（不细分）"（同看板支出分类）
export type AverageSubRow = AverageCells & { categoryId: string; unsplit: boolean };

// key 是一级分类 id 或归属人 id；按归属人时 children 是空的
export type AverageRow = AverageCells & { key: string; children: AverageSubRow[] };

export type AverageCategory = DashboardCategory & { isArchived: boolean };

export type MonthlyAverageCard = {
  months12: number; // "基于 n 个月"
  months3: number;
  total: AverageCells;
  byCategory: AverageRow[];
  byMember: AverageRow[];
  categories: Record<string, AverageCategory>; // 行里出现的一级、二级，含已归档
  members: { id: string; name: string }[]; // 含已归档的归属人，老拆分也有名字
};

// ---------- 查询 ----------

// R22.5 数据起点：本家庭最早一笔交易（任何分类、任何状态）；没有交易时 null
export async function firstTransactionDate(ctx: HouseholdContext): Promise<string | null> {
  const [row] = await db
    .select({ first: min(transaction.date) })
    .from(transaction)
    .where(eq(transaction.householdId, ctx.householdId));
  return row?.first ?? null;
}

// 含已归档：R22.6 归档分类的支出照算，列表里标"已归档"
export async function loadCategories(
  ctx: HouseholdContext,
): Promise<(Category & { isArchived: boolean })[]> {
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
      isArchived: category.isArchived,
    })
    .from(category)
    .where(eq(category.householdId, ctx.householdId));
}

// 含已归档：拆分可能还指向归档的归属人，名字用来排序和显示
export async function loadMembers(ctx: HouseholdContext): Promise<Member[]> {
  return db
    .select({ id: member.id, name: member.name, kind: member.kind })
    .from(member)
    .where(eq(member.householdId, ctx.householdId));
}

// R25.5 的实际每月存下要 isPreTax（summarize）和 goalId（排除挂了目标的），一起查
export type LoadedSplit = AverageSplit & { isPreTax: boolean; goalId: string | null };

// 交易日期在 start 到 end（含首尾）的所有拆分，pending 也算（R22.6）
export async function loadSplits(
  ctx: HouseholdContext,
  start: string,
  end: string,
): Promise<LoadedSplit[]> {
  return db
    .select({
      date: transaction.date,
      amountCents: transactionSplit.amountCents,
      categoryId: transactionSplit.categoryId,
      memberId: transactionSplit.memberId,
      isOneOff: transactionSplit.isOneOff,
      isPreTax: transactionSplit.isPreTax,
      goalId: transactionSplit.goalId,
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
        gte(transaction.date, start),
        lte(transaction.date, end),
      ),
    );
}

// ---------- 拼表格行 ----------

type Results = { avg12: MonthlyAverage; avg3: MonthlyAverage; current: MonthlyAverage };

function cellsOf(r: Results, get: (a: MonthlyAverage) => number): AverageCells {
  const avg12Cents = get(r.avg12);
  const currentCents = get(r.current);
  return {
    avg12Cents,
    avg3Cents: get(r.avg3),
    currentCents,
    percent: compareToAverage(currentCents, avg12Cents),
  };
}

// R22.8：按近 12 个月月均从大到小，一样按名字
function sortRows<T extends AverageCells>(rows: T[], nameOf: (row: T) => string): T[] {
  return rows.sort((a, b) => {
    if (a.avg12Cents !== b.avg12Cents) return b.avg12Cents - a.avg12Cents;
    const na = nameOf(a);
    const nb = nameOf(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
}

const subKey = (line: { categoryId: string; unsplit: boolean }) =>
  line.unsplit ? `${line.categoryId}-unsplit` : line.categoryId;

// R22.8：两个窗口或本月里任一个 ≠ 0 的一级都列（monthlyAverage 只给合计 ≠ 0 的行）
function categoryRows(r: Results, nameOf: (id: string) => string): AverageRow[] {
  const all = [r.avg12, r.avg3, r.current];
  const topIds = new Set(all.flatMap((a) => a.byCategory.map((t) => t.categoryId)));
  const topOf = (a: MonthlyAverage, id: string) => a.byCategory.find((t) => t.categoryId === id);

  const rows = [...topIds].map((id) => {
    const lines = new Map<string, { categoryId: string; unsplit: boolean }>();
    for (const a of all) {
      const top = topOf(a, id);
      if (top) for (const line of expenseSubLines(top)) lines.set(subKey(line), line);
    }
    const lineCents = (a: MonthlyAverage, key: string) => {
      const top = topOf(a, id);
      return top ? (expenseSubLines(top).find((l) => subKey(l) === key)?.cents ?? 0) : 0;
    };
    const children = [...lines].map(([key, line]) => ({
      ...line,
      ...cellsOf(r, (a) => lineCents(a, key)),
    }));
    return {
      key: id,
      ...cellsOf(r, (a) => topOf(a, id)?.cents ?? 0),
      children: sortRows(children, (c) => nameOf(c.categoryId)),
    };
  });
  return sortRows(rows, (row) => nameOf(row.key));
}

function memberRows(r: Results, nameOf: (id: string) => string): AverageRow[] {
  const all = [r.avg12, r.avg3, r.current];
  const ids = new Set(all.flatMap((a) => a.byMember.map((m) => m.memberId)));
  const rows = [...ids].map((id) => ({
    key: id,
    ...cellsOf(r, (a) => a.byMember.find((m) => m.memberId === id)?.cents ?? 0),
    children: [],
  }));
  return sortRows(rows, (row) => nameOf(row.key));
}

// ---------- getMonthlyAverage ----------

// R22.5 到 R22.9：没有完整月（n = 0）时 null，卡片显示"还没有完整月的数据"，不做对比
export async function getMonthlyAverage(
  ctx: HouseholdContext,
  today: string,
  memberId?: string,
): Promise<MonthlyAverageCard | null> {
  const first = await firstTransactionDate(ctx);
  const window12 = averageWindow(today, first, 12);
  if (window12.range === null) return null;
  const window3 = averageWindow(today, first, 3);

  // R22.9 本月 = 本月 1 日到今天。当成 1 个月的窗口交给 monthlyAverage，口径和月均完全一样，n = 1 时分配就是实际合计
  const thisMonth: AverageWindow = { months: 1, range: { start: startOfMonth(today), end: today } };

  // 近 3 个月在近 12 个月里面，一次查完窗口起点到今天
  const [categories, members, all] = await Promise.all([
    loadCategories(ctx),
    loadMembers(ctx),
    loadSplits(ctx, window12.range.start, today),
  ]);
  const splits = filterByMember(all, memberId);

  const results: Results = {
    avg12: monthlyAverage(splits, categories, members, window12)!,
    avg3: monthlyAverage(splits, categories, members, window3)!,
    current: monthlyAverage(splits, categories, members, thisMonth)!,
  };

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const memberName = new Map(members.map((m) => [m.id, m.name]));
  const byCategory = categoryRows(results, (id) => categoryById.get(id)?.nameEn ?? id);
  const byMember = memberRows(results, (id) => memberName.get(id) ?? id);

  const used = new Set(byCategory.flatMap((t) => [t.key, ...t.children.map((c) => c.categoryId)]));
  const picked: Record<string, AverageCategory> = {};
  for (const id of used) {
    const c = categoryById.get(id);
    if (c) {
      picked[id] = {
        id: c.id,
        parentId: c.parentId,
        nameEn: c.nameEn,
        kind: c.kind,
        systemKey: c.systemKey,
        isArchived: c.isArchived,
      };
    }
  }

  return {
    months12: window12.months,
    months3: window3.months,
    total: cellsOf(results, (a) => a.totalCents),
    byCategory,
    byMember,
    categories: picked,
    members: members.map(({ id, name }) => ({ id, name })),
  };
}

// ---------- getBudgetAverage ----------

// R22.11：新建预算的默认上限用近 12 个月月均，按全家（不跟归属人筛选）
// 没有完整月时 null。各分类的值由调用方用 categoryAverage 取
export async function getBudgetAverage(
  ctx: HouseholdContext,
  today: string,
): Promise<MonthlyAverage | null> {
  const first = await firstTransactionDate(ctx);
  const window12 = averageWindow(today, first, 12);
  if (window12.range === null) return null;

  const [categories, members, splits] = await Promise.all([
    loadCategories(ctx),
    loadMembers(ctx),
    loadSplits(ctx, window12.range.start, window12.range.end),
  ]);
  return monthlyAverage(splits, categories, members, window12);
}
