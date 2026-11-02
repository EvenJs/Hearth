// 月均支出（business-rules.md R22.5 到 R22.9、R22.11）
// 口径同 R10 支出（bucketOf），另外排除 is_one_off = true 的拆分
// 纯函数，不 import 数据库和 Next.js
import type { OneOffFlag } from './one-off';
import { addDays, startOfMonth, type DateRange } from './periods';
import { bucketOf, indexCategories, percentChange, type CategoryTotal } from './stats';
import type { Category, Member } from './types';

// 月均需要的拆分字段（date 是所属交易的日期）
export type AverageSplit = {
  date: string; // YYYY-MM-DD
  amountCents: number;
  categoryId: string;
  memberId: string;
  isOneOff: OneOffFlag;
};

// R22.5：months = 0 时没有完整月，range 为 null
export type AverageWindow = { months: number; range: DateRange | null };

export type MonthlyAverage = {
  months: number; // "基于 n 个月"
  totalCents: number;
  // 窗口合计 ≠ 0 的一级（二级同样），按月均从大到小，一样按名字。系统分类没有二级
  byCategory: CategoryTotal[];
  byMember: { memberId: string; cents: number }[];
};

// ---------- R22.5 窗口 ----------

// 0 = 公元 0 年 1 月
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function monthStart(index: number): string {
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

// R22.5：上个月往前数 months 个完整月，早于数据起点（最早一笔交易所在的月）的不算
// firstDate 为 null = 本家庭还没有交易
export function averageWindow(
  today: string,
  firstDate: string | null,
  months: number,
): AverageWindow {
  if (!Number.isInteger(months) || months < 1) throw new Error(`窗口月数必须是正整数: ${months}`);
  const end = addDays(startOfMonth(today), -1); // 上个月最后一天
  if (firstDate === null) return { months: 0, range: null };

  const last = monthIndex(end);
  const first = Math.max(last - months + 1, monthIndex(startOfMonth(firstDate)));
  const n = last - first + 1;
  if (n <= 0) return { months: 0, range: null };
  return { months: n, range: { start: monthStart(first), end } };
}

// ---------- R22.7 取整 ----------

// R22.7 第 1 步：s ÷ n 四舍五入到分，按绝对值（−500.5 → −501）
function roundDiv(s: number, n: number): number {
  const q = Math.floor((2 * Math.abs(s) + n) / (2 * n));
  return s < 0 && q > 0 ? -q : q;
}

type Share = { key: string; name: string; cents: number }; // cents 是窗口合计 s

function byName(a: Share, b: Share): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// R22.7 第 2、3 步：最大余数法，把 target 分给各行，加起来正好等于 target
// 每行先拿 floor(s ÷ n)，差的 k 分按 s mod n 从大到小给；余数一样 s 大的先，再一样按名字
// R20.3 的整单折扣分摊是"余数全给最大的一组"，不是这个方法，不能共用
function allocateLargestRemainder(
  shares: readonly Share[],
  n: number,
  target: number,
): Map<string, number> {
  const result = new Map<string, number>();
  const remainder = new Map<string, number>();
  let k = target;
  for (const s of shares) {
    const floor = Math.floor(s.cents / n); // 负数也向下取整：−1 ÷ 3 = −1
    result.set(s.key, floor);
    remainder.set(s.key, s.cents - floor * n); // 0 到 n − 1，整数比较
    k -= floor;
  }
  // target 是这些行合计 ÷ n 四舍五入（或上一层分到的值），k 一定在 0 到行数之间
  if (k < 0 || k > shares.length) throw new Error(`最大余数法分配出错: k = ${k}`);

  const order = [...shares].sort(
    (a, b) => remainder.get(b.key)! - remainder.get(a.key)! || b.cents - a.cents || byName(a, b),
  );
  for (const s of order.slice(0, k)) result.set(s.key, result.get(s.key)! + 1);
  return result;
}

// 按分到的月均从大到小，一样按名字
function byAverageDesc(a: Share, b: Share): number {
  return b.cents - a.cents || byName(a, b);
}

// ---------- R22.6 到 R22.8 ----------

function add(map: Map<string, number>, key: string, cents: number) {
  map.set(key, (map.get(key) ?? 0) + cents);
}

function nonZero(totals: Map<string, number>, nameOf: (key: string) => string): Share[] {
  return [...totals.entries()]
    .filter(([, cents]) => cents !== 0)
    .map(([key, cents]) => ({ key, name: nameOf(key), cents }));
}

// R22.6：窗口内支出合计 ÷ 月数，按一级（带二级）、归属人分；months = 0 时 null
// 归属人筛选（R22.8 跟 R10.6）由调用方先用 filterByMember 筛好
export function monthlyAverage(
  splits: readonly AverageSplit[],
  categories: readonly Category[],
  members: readonly Member[],
  window: AverageWindow,
): MonthlyAverage | null {
  if (window.months === 0 || window.range === null) return null;
  const n = window.months;
  const { start, end } = window.range;
  const idx = indexCategories(categories);

  // 一级 id → (拆分的分类 id → s)；分类 id 可能就是一级自己（拆分直接选了一级）
  const tops = new Map<string, Map<string, number>>();
  const memberTotals = new Map<string, number>();
  let total = 0;

  for (const s of splits) {
    if (s.date < start || s.date > end) continue;
    if (s.isOneOff === true) continue; // R22.6：null 和 false 都算
    if (bucketOf(idx.get(s.categoryId)) !== 'expense') continue;

    const cents = -s.amountCents; // 退款正数直接冲减
    total += cents;
    const topId = idx.topOf(s.categoryId);
    let top = tops.get(topId);
    if (!top) {
      top = new Map();
      tops.set(topId, top);
    }
    add(top, s.categoryId, cents);
    add(memberTotals, s.memberId, cents);
  }

  const totalCents = roundDiv(total, n);
  const categoryName = (id: string) => idx.get(id).nameEn;
  const memberNames = new Map(members.map((m) => [m.id, m.name]));
  const memberName = (id: string) => memberNames.get(id) ?? id;

  const topShares = nonZero(
    new Map([...tops].map(([id, items]) => [id, [...items.values()].reduce((a, c) => a + c, 0)])),
    categoryName,
  );
  const topAverage = allocateLargestRemainder(topShares, n, totalCents);

  const byCategory = topShares
    .map((t) => ({ ...t, cents: topAverage.get(t.key)! }))
    .sort(byAverageDesc)
    .map((t) => {
      // 二级在一级分到的月均里再分一次。直接记在一级上的金额也参与分配，只是不列成二级
      const items = nonZero(tops.get(t.key)!, categoryName);
      const childAverage = allocateLargestRemainder(items, n, t.cents);
      const children = items
        .filter((c) => c.key !== t.key)
        .map((c) => ({ ...c, cents: childAverage.get(c.key)! }))
        .sort(byAverageDesc)
        .map((c) => ({ categoryId: c.key, cents: c.cents }));
      return { categoryId: t.key, cents: t.cents, children };
    });

  const memberShares = nonZero(memberTotals, memberName);
  const memberAverage = allocateLargestRemainder(memberShares, n, totalCents);
  const byMember = memberShares
    .map((m) => ({ ...m, cents: memberAverage.get(m.key)! }))
    .sort(byAverageDesc)
    .map((m) => ({ memberId: m.key, cents: m.cents }));

  return { months: n, totalCents, byCategory, byMember };
}

// 某个分类（一级或二级）分到的月均；窗口里没有就是 0，没有完整月是 null
export function categoryAverage(average: MonthlyAverage | null, categoryId: string): number | null {
  if (average === null) return null;
  for (const top of average.byCategory) {
    if (top.categoryId === categoryId) return top.cents;
    const child = top.children.find((c) => c.categoryId === categoryId);
    if (child) return child.cents;
  }
  return 0;
}

// ---------- R22.9 本月对比 ----------

// R22.9：(本月 − 近 12 个月月均) ÷ 月均，整数百分比，舍入同 R10.4；月均 ≤ 0 时 null（显示"—"）
export function compareToAverage(currentCents: number, averageCents: number): number | null {
  return percentChange(currentCents, averageCents);
}

// ---------- R22.11 新建预算的默认上限 ----------

// R22.11：月均四舍五入到整元（分）；月均 ≤ 0 或没有完整月时 null，不填
// 不到 $0.50 的月均舍入后是 $0，也当不填（预算上限要 > 0，R11）
export function suggestedBudgetLimit(averageCents: number | null): number | null {
  if (averageCents === null || averageCents <= 0) return null;
  const limit = Math.floor((averageCents + 50) / 100) * 100;
  return limit > 0 ? limit : null;
}
