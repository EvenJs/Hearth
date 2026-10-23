// 统计和汇总（business-rules.md R10、R10.2、R11）
// 全部基于 transaction_split，按交易的 date 归入时间段
// 纯函数，不 import 数据库和 Next.js
import { addDays, endOfMonth, mondayOf, startOfMonth, type DateRange } from './periods';
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
type Bucket = Metric | 'uncategorized' | 'excluded';

function bucketOf(c: Category): Bucket {
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

type CategoryIndex = {
  get: (id: string) => Category;
  // 一级分类 id（自己是一级时返回自己）
  topOf: (id: string) => string;
};

function indexCategories(categories: readonly Category[]): CategoryIndex {
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
