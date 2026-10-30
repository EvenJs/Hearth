// 统计和汇总（business-rules.md R10、R10.2、R11）
// 全部基于 transaction_split，按交易的 date 归入时间段
// 纯函数，不 import 数据库和 Next.js
import { addDays, endOfMonth, mondayOf, startOfMonth, type DateRange } from './periods';
import type { TransactionStatus } from '@/lib/transactions/filters';
import type { Category } from './types';

// 统计需要的拆分字段（date 是所属交易的日期）
export type StatSplit = {
  date: string; // YYYY-MM-DD
  amountCents: number;
  categoryId: string;
  memberId: string;
  isPreTax: boolean;
};

export type Metric = 'income' | 'expense';

// R10：一笔拆分算哪一类
export type Bucket = Metric | 'uncategorized' | 'excluded';

export function bucketOf(c: Category): Bucket {
  if (c.kind === 'income') return 'income';
  if (c.kind === 'expense') return 'expense';
  switch (c.systemKey) {
    case 'cash_withdrawal':
    case 'bank_fee':
      return 'expense'; // 系统分类"现金支出"、"银行费用"计入支出
    case 'uncategorized':
      return 'uncategorized'; // 单独显示，不计入收支
    default:
      // 内部转账（auto、confirmed 时分类才是内部转账；suggested 保留原分类，按普通交易算）
      return 'excluded';
  }
}

// 收入 = Σ 金额；支出 = −Σ 金额（退款正数直接冲减）
function signed(metric: Metric, amountCents: number): number {
  return metric === 'income' ? amountCents : -amountCents;
}

function inRange(date: string, range: DateRange): boolean {
  return date >= range.start && date <= range.end;
}

export type CategoryIndex = {
  get: (id: string) => Category;
  // 一级分类 id（自己是一级时返回自己）
  topOf: (id: string) => string;
};

export function indexCategories(categories: readonly Category[]): CategoryIndex {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const get = (id: string) => {
    const c = byId.get(id);
    if (!c) throw new Error(`找不到分类: ${id}`);
    return c;
  };
  return { get, topOf: (id) => get(id).parentId ?? id };
}

// 金额大的在前；相同按 id，保证顺序稳定
function byCentsDesc<T extends { cents: number; key: string }>(a: T, b: T): number {
  return b.cents - a.cents || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// ---------- R10 summarize ----------

export type CategoryTotal = {
  categoryId: string; // 一级
  cents: number; // 支出为正数，可能为负（退款大于支出）
  children: { categoryId: string; cents: number }[]; // 二级；系统分类没有
};

export type MemberTotal = {
  memberId: string;
  incomeCents: number;
  expenseCents: number;
};

export type Summary = {
  incomeCents: number; // 含 Tax (ATO) 的负数
  preTaxIncomeCents: number; // "其中税前 $X"
  expenseCents: number;
  savingsRate: number | null; // 0.25 = 25%；收入 ≤ 0 时为 null，显示"—"
  expenseByCategory: CategoryTotal[];
  incomeByCategory: CategoryTotal[];
  byMember: MemberTotal[]; // 只列出有收支的归属人，界面上没出现的按 0 显示
  uncategorized: { count: number; amountCents: number }; // amountCents 是原始金额合计（带符号）
};

function groupByCategory(
  items: { categoryId: string; cents: number }[],
  idx: CategoryIndex,
): CategoryTotal[] {
  const tops = new Map<string, { cents: number; children: Map<string, number> }>();
  for (const { categoryId, cents } of items) {
    const topId = idx.topOf(categoryId);
    let top = tops.get(topId);
    if (!top) {
      top = { cents: 0, children: new Map() };
      tops.set(topId, top);
    }
    top.cents += cents;
    if (topId !== categoryId)
      top.children.set(categoryId, (top.children.get(categoryId) ?? 0) + cents);
  }

  return [...tops.entries()]
    .map(([key, t]) => ({
      key,
      cents: t.cents,
      children: [...t.children.entries()]
        .map(([k, cents]) => ({ key: k, cents }))
        .sort(byCentsDesc)
        .map(({ key: categoryId, cents }) => ({ categoryId, cents })),
    }))
    .sort(byCentsDesc)
    .map(({ key, cents, children }) => ({ categoryId: key, cents, children }));
}

export function summarize(
  splits: readonly StatSplit[],
  categories: readonly Category[],
  range: DateRange,
): Summary {
  const idx = indexCategories(categories);

  let incomeCents = 0;
  let preTaxIncomeCents = 0;
  let expenseCents = 0;
  const uncategorized = { count: 0, amountCents: 0 };
  const expenseItems: { categoryId: string; cents: number }[] = [];
  const incomeItems: { categoryId: string; cents: number }[] = [];
  const members = new Map<string, MemberTotal>();
  const memberOf = (memberId: string) => {
    let m = members.get(memberId);
    if (!m) {
      m = { memberId, incomeCents: 0, expenseCents: 0 };
      members.set(memberId, m);
    }
    return m;
  };

  for (const s of splits) {
    if (!inRange(s.date, range)) continue;
    const bucket = bucketOf(idx.get(s.categoryId));

    if (bucket === 'uncategorized') {
      uncategorized.count += 1;
      uncategorized.amountCents += s.amountCents;
    } else if (bucket === 'income') {
      incomeCents += s.amountCents;
      if (s.isPreTax) preTaxIncomeCents += s.amountCents;
      incomeItems.push({ categoryId: s.categoryId, cents: s.amountCents });
      memberOf(s.memberId).incomeCents += s.amountCents;
    } else if (bucket === 'expense') {
      const cents = -s.amountCents;
      expenseCents += cents;
      expenseItems.push({ categoryId: s.categoryId, cents });
      memberOf(s.memberId).expenseCents += cents;
    }
  }

  return {
    incomeCents,
    preTaxIncomeCents,
    expenseCents,
    savingsRate: incomeCents > 0 ? (incomeCents - expenseCents) / incomeCents : null,
    expenseByCategory: groupByCategory(expenseItems, idx),
    incomeByCategory: groupByCategory(incomeItems, idx),
    byMember: [...members.values()],
    uncategorized,
  };
}

// ---------- R10.2 pivot ----------

export type Granularity = 'week' | 'month';
export type GroupBy = 'category' | 'member';

// 时间段首尾不满一周或一个月的，只算时间段内的日子，partial = true（表头标"部分"）
export type PivotColumn = { start: string; end: string; partial: boolean };

export type PivotRow = {
  key: string; // 分组 = 分类时是一级分类 id，= 归属人时是 member id
  cells: number[]; // 和 columns 一一对应
  total: number; // 行合计
  children: PivotRow[]; // 按分类分组时的二级，可展开；按归属人分组时为空
};

export type Pivot = {
  columns: PivotColumn[];
  rows: PivotRow[];
  columnTotals: number[];
  total: number;
};

// R10.2：把时间段按周（周一到周日）或自然月切开
export function pivotColumns(range: DateRange, granularity: Granularity): PivotColumn[] {
  const columns: PivotColumn[] = [];
  let cursor = range.start;
  while (cursor <= range.end) {
    const fullStart = granularity === 'week' ? mondayOf(cursor) : startOfMonth(cursor);
    const fullEnd = granularity === 'week' ? addDays(fullStart, 6) : endOfMonth(cursor);
    const end = fullEnd < range.end ? fullEnd : range.end;
    columns.push({ start: cursor, end, partial: cursor !== fullStart || end !== fullEnd });
    cursor = addDays(end, 1);
  }
  return columns;
}

function columnIndex(columns: PivotColumn[], date: string): number {
  return columns.findIndex((c) => date >= c.start && date <= c.end);
}

export function pivot(
  splits: readonly StatSplit[],
  categories: readonly Category[],
  range: DateRange,
  granularity: Granularity,
  groupBy: GroupBy,
  metric: Metric = 'expense',
): Pivot {
  const idx = indexCategories(categories);
  const columns = pivotColumns(range, granularity);
  const n = columns.length;

  // 一级 key → { cells, 二级 key → cells }
  const groups = new Map<string, { cells: number[]; children: Map<string, number[]> }>();
  const zeros = () => new Array<number>(n).fill(0);

  for (const s of splits) {
    if (!inRange(s.date, range)) continue;
    if (bucketOf(idx.get(s.categoryId)) !== metric) continue;

    const col = columnIndex(columns, s.date);
    const cents = signed(metric, s.amountCents);
    const key = groupBy === 'category' ? idx.topOf(s.categoryId) : s.memberId;

    let g = groups.get(key);
    if (!g) {
      g = { cells: zeros(), children: new Map() };
      groups.set(key, g);
    }
    g.cells[col] += cents;

    if (groupBy === 'category' && key !== s.categoryId) {
      let child = g.children.get(s.categoryId);
      if (!child) {
        child = zeros();
        g.children.set(s.categoryId, child);
      }
      child[col] += cents;
    }
  }

  const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  const toRow = (key: string, cells: number[], children: PivotRow[]): PivotRow => ({
    key,
    cells,
    total: sum(cells),
    children,
  });
  const sortRows = (rows: PivotRow[]) =>
    [...rows].sort((a, b) =>
      byCentsDesc({ key: a.key, cents: a.total }, { key: b.key, cents: b.total }),
    );

  const rows = sortRows(
    [...groups.entries()].map(([key, g]) =>
      toRow(
        key,
        g.cells,
        sortRows([...g.children.entries()].map(([k, cells]) => toRow(k, cells, []))),
      ),
    ),
  );

  const columnTotals = columns.map((_, i) => sum(rows.map((r) => r.cells[i])));
  return { columns, rows, columnTotals, total: sum(columnTotals) };
}

// ---------- R11 budgetProgress ----------

export type BudgetInput = {
  id: string;
  categoryId: string; // 一级：统计它下面所有二级；二级：只统计这个二级
  monthlyLimitCents: number; // > 0
  warnAtPercent: number; // 默认 80
};

export type BudgetLevel = 'ok' | 'warn' | 'over';

export type BudgetProgress = {
  budgetId: string;
  categoryId: string;
  spentCents: number; // R10 支出口径，退款冲减，可能为负
  limitCents: number;
  percent: number; // 显示用，78.975 = 78.975%
  level: BudgetLevel; // ≥ warn_at_percent → warn；≥ 100% → over
};

// R11：只按自然月计算，取 today 所在的整月
export function budgetProgress(
  budgets: readonly BudgetInput[],
  splits: readonly StatSplit[],
  categories: readonly Category[],
  today: string,
): BudgetProgress[] {
  const idx = indexCategories(categories);
  const month = { start: startOfMonth(today), end: endOfMonth(today) };

  // 本月每个分类（二级和一级各记一份）的支出
  const spentBy = new Map<string, number>();
  const add = (id: string, cents: number) => spentBy.set(id, (spentBy.get(id) ?? 0) + cents);
  for (const s of splits) {
    if (!inRange(s.date, month)) continue;
    if (bucketOf(idx.get(s.categoryId)) !== 'expense') continue;
    const cents = -s.amountCents;
    add(s.categoryId, cents);
    const top = idx.topOf(s.categoryId);
    if (top !== s.categoryId) add(top, cents);
  }

  return budgets.map((b) => {
    idx.get(b.categoryId);
    const spent = spentBy.get(b.categoryId) ?? 0;
    const limit = b.monthlyLimitCents;
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error(`预算上限必须是正整数分: ${limit}`);

    // 用整数比较，不受浮点误差影响
    const level: BudgetLevel =
      spent >= limit ? 'over' : spent * 100 >= b.warnAtPercent * limit ? 'warn' : 'ok';

    return {
      budgetId: b.id,
      categoryId: b.categoryId,
      spentCents: spent,
      limitCents: limit,
      percent: (spent * 100) / limit,
      level,
    };
  });
}

// ---------- M5 看板（R10.3 到 R10.6） ----------

// R10.3 Top 商家要按交易合并拆分，所以多带交易 id 和商家。不改 StatSplit，免得动到已有测试
export type MerchantSplit = StatSplit & {
  transactionId: string;
  merchant: string;
};

export type MerchantTotal = {
  merchant: string;
  count: number; // 花了钱的交易笔数
  cents: number; // 支出为正数，退款已冲减
};

// R10.3：按商家分组，按笔数排，取前 n 个
export function topMerchants(
  splits: readonly MerchantSplit[],
  categories: readonly Category[],
  range: DateRange,
  n: number,
): MerchantTotal[] {
  const idx = indexCategories(categories);

  // R10.3：一笔交易算一次，先把这笔交易里命中的支出拆分加起来（原始带符号金额）
  const byTransaction = new Map<string, { merchant: string; amountCents: number }>();
  for (const s of splits) {
    if (!inRange(s.date, range)) continue;
    if (bucketOf(idx.get(s.categoryId)) !== 'expense') continue;
    const t = byTransaction.get(s.transactionId);
    if (t) t.amountCents += s.amountCents;
    else
      byTransaction.set(s.transactionId, {
        merchant: s.merchant,
        amountCents: s.amountCents,
      });
  }

  const merchants = new Map<string, MerchantTotal>();
  for (const { merchant, amountCents } of byTransaction.values()) {
    let m = merchants.get(merchant);
    if (!m) {
      m = { merchant, count: 0, cents: 0 };
      merchants.set(merchant, m);
    }
    // 负数（花了钱）→ 笔数 +1；正数（退款）→ 只冲减金额。合计正好是 0 时两样都不变
    if (amountCents < 0) m.count += 1;
    m.cents -= amountCents;
  }

  return [...merchants.values()]
    .filter((m) => m.count > 0) // R10.3：笔数是 0 的商家不列
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.cents - a.cents ||
        (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0),
    )
    .slice(0, n);
}

// R10.4 对比上期 ---------------------------------------------

export type Comparison = {
  incomePercent: number | null; // 整数百分比，+14 = +14%；不能比时 null，显示"—"
  expensePercent: number | null;
  savingsRatePoints: number | null; // 整数百分点，+3 = +3 pp
};

type Totals = Pick<Summary, 'incomeCents' | 'expenseCents'>;

// num ÷ den 四舍五入到整数，按绝对值舍入再带上符号（-12.5 → -13）。den > 0
// 用 BigInt 整数运算，不受浮点误差影响
function roundRatio(num: bigint, den: bigint): number {
  const zero = BigInt(0);
  const two = BigInt(2);
  const abs = num < zero ? -num : num;
  const q = (two * abs + den) / (two * den); // BigInt 除法向下取整
  return Number(num < zero ? -q : q);
}

// R10.4：(本期 − 上期) ÷ 上期；上期 ≤ 0 时 null
function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return roundRatio(BigInt(current - previous) * BigInt(100), BigInt(previous));
}

// R10.4：储蓄率百分点差 = 本期 − 上期；任一期储蓄率是"—"（收入 ≤ 0，同 summarize）时 null
// (Ic−Ec)/Ic − (Ip−Ep)/Ip = ((Ic−Ec)·Ip − (Ip−Ep)·Ic) / (Ic·Ip)
function savingsRateDiff(c: Totals, p: Totals): number | null {
  if (c.incomeCents <= 0 || p.incomeCents <= 0) return null;
  const ic = BigInt(c.incomeCents);
  const ip = BigInt(p.incomeCents);
  const num = (ic - BigInt(c.expenseCents)) * ip - (ip - BigInt(p.expenseCents)) * ic;
  return roundRatio(num * BigInt(100), ic * ip);
}

// R10.4：未分类不对比
export function compare(current: Totals, previous: Totals): Comparison {
  return {
    incomePercent: percentChange(current.incomeCents, previous.incomeCents),
    expensePercent: percentChange(current.expenseCents, previous.expenseCents),
    savingsRatePoints: savingsRateDiff(current, previous),
  };
}

// R10.5 近 12 个月趋势 ---------------------------------------

export type MonthTrend = DateRange & {
  incomeCents: number;
  expenseCents: number;
  netCents: number; // 收入 − 支出
};

// R10.5：每月收入、支出口径同 summarize；没有数据的月份是 0，不跳过
export function monthlyTrend(
  splits: readonly StatSplit[],
  categories: readonly Category[],
  months: readonly DateRange[],
): MonthTrend[] {
  return months.map(({ start, end }) => {
    const { incomeCents, expenseCents } = summarize(splits, categories, {
      start,
      end,
    });
    return {
      start,
      end,
      incomeCents,
      expenseCents,
      netCents: incomeCents - expenseCents,
    };
  });
}

// R10.6 归属人筛选和 pending ---------------------------------

// R10.6：选了归属人时只留这个归属人的拆分；不选时原样返回
export function filterByMember<T extends { memberId: string }>(
  splits: readonly T[],
  memberId: string | undefined,
): T[] {
  return memberId === undefined ? [...splits] : splits.filter((s) => s.memberId === memberId);
}

export type PendingSplit = {
  transactionId: string;
  date: string;
  status: TransactionStatus;
};

// R10.6："含 N 笔待确认交易"：时间段内、有拆分命中的 pending 交易笔数
// 传进来的拆分要先经过 filterByMember
export function pendingCount(splits: readonly PendingSplit[], range: DateRange): number {
  const ids = new Set<string>();
  for (const s of splits) {
    if (s.status === 'pending' && inRange(s.date, range)) ids.add(s.transactionId);
  }
  return ids.size;
}
