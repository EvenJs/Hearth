import { describe, expect, it } from "vitest";
import { processFile } from "@/lib/import/process";
import { readFixture } from "../../../tests/helpers/fixtures";
import { buildTestHousehold } from "../../../tests/helpers/household";
import { lastTwelveMonths, periodRange, previousPeriod } from "./periods";
import {
  budgetProgress,
  compare,
  filterByMember,
  monthlyTrend,
  pendingCount,
  pivot,
  summarize,
  topMerchants,
  type MerchantSplit,
  type PendingSplit,
  type StatSplit,
  type Summary,
} from "./stats";
import type { ProcessedRow } from "./types";

// 期望值来自 fixtures/README.md "2026 年 9 月统计"、"按周汇总"、"拆分后 9 月统计"、CBA "9 月统计"，
// business-rules.md R10、R10.2、R11、R15.5，docs/tasks/m2.md M2-11

const h = buildTestHousehold();
const SEPT = periodRange(
  { start: "2026-09-01", end: "2026-09-30" },
  "2026-10-23",
);

function processed(
  path: "anz/joint-2026-09.csv" | "cba/female-2026-09.csv",
  account: string,
) {
  const result = processFile(readFixture(path), h.account(account), h);
  if (!result.ok) throw new Error(result.message);
  return result.rows;
}

// 每笔交易一个主拆分（导入时只建主拆分，R15.1）
function toSplit(r: ProcessedRow): StatSplit {
  return {
    date: r.date,
    amountCents: r.amountCents,
    categoryId: r.categoryId,
    memberId: r.memberId,
    isPreTax: r.isPreTax,
  };
}

// fixtures 表里的 # 从 1 开始，顺序和文件一致
function jointSplits(): StatSplit[] {
  return processed("anz/joint-2026-09.csv", "ANZ Joint").map(toSplit);
}

const cat = (path: string) => h.category(path).id;
const mem = (name: string) => h.member(name).id;

function expenseOf(s: Summary, path: string): number | undefined {
  const c = h.category(path);
  if (!c.parentId)
    return s.expenseByCategory.find((t) => t.categoryId === c.id)?.cents;
  const top = s.expenseByCategory.find((t) => t.categoryId === c.parentId);
  return top?.children.find((t) => t.categoryId === c.id)?.cents;
}

function memberExpense(s: Summary, name: string): number {
  return s.byMember.find((m) => m.memberId === mem(name))?.expenseCents ?? 0;
}

describe("summarize：joint-2026-09.csv 9 月（R10）", () => {
  const s = summarize(jointSplits(), h.categories, SEPT);

  it("R10: expense includes cash withdrawal and bank fees, excludes transfers and uncategorised", () => {
    expect(s.expenseCents).toBe(45575);
  });

  it('R10: income is 0 and savings rate is null ("—")', () => {
    expect(s.incomeCents).toBe(0);
    expect(s.preTaxIncomeCents).toBe(0);
    expect(s.savingsRate).toBeNull();
  });

  it("R10: uncategorised is shown separately (#7, #15, #16, #18)", () => {
    expect(s.uncategorized).toEqual({
      count: 4,
      amountCents: 8000 - 1200 - 2715 + 30000,
    });
  });

  it("R10/R7.1: refunds offset the category", () => {
    expect(expenseOf(s, "Groceries / Supermarket")).toBe(15795);
    expect(expenseOf(s, "Groceries")).toBe(15795);
  });

  it("R10: a category can be negative and is shown as is", () => {
    expect(expenseOf(s, "Personal & medical / Other")).toBe(-4580);
  });

  it("R10: bank fee and its reversal cancel out to 0", () => {
    expect(expenseOf(s, "Bank fees")).toBe(0);
  });

  it("R10: system expense categories have no children", () => {
    const cash = s.expenseByCategory.find(
      (t) => t.categoryId === cat("Cash withdrawal"),
    );
    expect(cash).toEqual({
      categoryId: cat("Cash withdrawal"),
      cents: 15000,
      children: [],
    });
  });

  it("R10: internal transfer and uncategorised never appear in category totals", () => {
    const ids = s.expenseByCategory.map((t) => t.categoryId);
    expect(ids).not.toContain(cat("Internal transfer"));
    expect(ids).not.toContain(cat("Uncategorised"));
  });

  it("R10: second-level totals add up to the first level", () => {
    for (const top of s.expenseByCategory) {
      if (top.children.length === 0) continue;
      expect(
        top.children.reduce((a, c) => a + c.cents, 0),
        top.categoryId,
      ).toBe(top.cents);
    }
  });

  it("R10: category totals add up to total expense", () => {
    expect(s.expenseByCategory.reduce((a, t) => a + t.cents, 0)).toBe(
      s.expenseCents,
    );
  });

  it("R10: expense by member Male 900, Female 0, Home 44675", () => {
    expect(memberExpense(s, "Male")).toBe(900);
    expect(memberExpense(s, "Female")).toBe(0);
    expect(memberExpense(s, "Home")).toBe(44675);
  });

  it("R10: only splits inside the range are counted by date", () => {
    const half = summarize(
      jointSplits(),
      h.categories,
      periodRange({ start: "2026-09-21", end: "2026-09-30" }, "2026-10-23"),
    );
    expect(half.expenseCents).toBe(21120 + 10740);
    const none = summarize(
      jointSplits(),
      h.categories,
      periodRange("this_month", "2026-10-23"),
    );
    expect(none.expenseCents).toBe(0);
    expect(none.uncategorized).toEqual({ count: 0, amountCents: 0 });
  });
});

describe("summarize：内部转账（R10、R6）", () => {
  it("R10: auto transfers (#11, #17) are not income or expense", () => {
    const splits = jointSplits();
    const without = splits.filter((_, i) => i !== 10 && i !== 16);
    const a = summarize(splits, h.categories, SEPT);
    const b = summarize(without, h.categories, SEPT);
    expect(a).toEqual(b);
  });

  it("R6.3: suggested keeps its category (Uncategorised) and is counted as usual", () => {
    // #7 被标 suggested 后分类不变
    const s = summarize(jointSplits(), h.categories, SEPT);
    expect(s.uncategorized.count).toBe(4);
  });

  it("R6.3: confirmed moves to Internal transfer and drops out of the stats", () => {
    const splits = jointSplits();
    splits[6] = { ...splits[6], categoryId: cat("Internal transfer") };
    const s = summarize(splits, h.categories, SEPT);
    expect(s.uncategorized).toEqual({
      count: 3,
      amountCents: -1200 - 2715 + 30000,
    });
    expect(s.incomeCents).toBe(0);
    expect(s.expenseCents).toBe(45575);
  });
});

describe("summarize：拆分后（R15.5）", () => {
  // #19 COLES -58.40 拆出 15.00 Household supplies 和 8.00 Cosmetics（都不选归属人）
  function splitSplits(): StatSplit[] {
    const splits = jointSplits();
    const coles = splits[18];
    return [
      ...splits.slice(0, 18),
      { ...coles, amountCents: -3540 },
      {
        ...coles,
        amountCents: -1500,
        categoryId: cat("Home & utilities / Household supplies"),
        memberId: mem("Home"),
      },
      {
        ...coles,
        amountCents: -800,
        categoryId: cat("Personal & medical / Cosmetics & toiletries"),
        memberId: mem("Male"),
      },
    ];
  }

  const s = summarize(splitSplits(), h.categories, SEPT);

  it("R15.4: total expense is unchanged", () => {
    expect(s.expenseCents).toBe(45575);
  });

  it("R15.4: each split counts in its own category", () => {
    expect(expenseOf(s, "Groceries / Supermarket")).toBe(13495);
    expect(expenseOf(s, "Home & utilities / Household supplies")).toBe(1500);
    expect(expenseOf(s, "Personal & medical / Cosmetics & toiletries")).toBe(
      800,
    );
  });

  it("R15.4: each split counts for its own member", () => {
    expect(memberExpense(s, "Male")).toBe(1700);
    expect(memberExpense(s, "Female")).toBe(0);
    expect(memberExpense(s, "Home")).toBe(43875);
  });
});

describe("summarize：cba/female-2026-09.csv 9 月，手动操作后（R10）", () => {
  function femaleSplits(): StatSplit[] {
    const splits = processed("cba/female-2026-09.csv", "CBA Female").map(
      toSplit,
    );
    // 手动 1：#3 → Contract income (B2B)，is_pre_tax 跟着变 true
    splits[2] = {
      ...splits[2],
      categoryId: cat("Income / Contract income (B2B)"),
      isPreTax: true,
    };
    // 手动 2：#15 → Restaurants（朋友 AA 转回来，冲减支出）
    splits[14] = {
      ...splits[14],
      categoryId: cat("Entertainment & eat-out / Restaurants"),
    };
    // #10 和 joint #11 配对后（R6.2）变成内部转账
    splits[9] = { ...splits[9], categoryId: cat("Internal transfer") };
    return splits;
  }

  const s = summarize(femaleSplits(), h.categories, SEPT);

  it("R10: income includes the negative Tax (ATO) payment", () => {
    expect(s.incomeCents).toBe(1234 - 90000 + 300000 + 400 + 41000);
    expect(s.incomeCents).toBe(252634);
  });

  it("R10: pre-tax part of income is shown separately", () => {
    expect(s.preTaxIncomeCents).toBe(301234);
  });

  it("R10: expense", () => {
    expect(s.expenseCents).toBe(245875);
  });

  it("R10: savings rate = (income − expense) ÷ income", () => {
    expect(s.savingsRate).toBeCloseTo((252634 - 245875) / 252634, 10);
  });

  it("R10/R7.1: friend paying back offsets Restaurants", () => {
    expect(expenseOf(s, "Entertainment & eat-out / Restaurants")).toBe(2250);
  });

  it("R10: expense by member Home 244525, Female 1350", () => {
    expect(memberExpense(s, "Home")).toBe(244525);
    expect(memberExpense(s, "Female")).toBe(1350);
    expect(memberExpense(s, "Male")).toBe(0);
  });

  it("R10: uncategorised is #12 and #13", () => {
    expect(s.uncategorized).toEqual({ count: 2, amountCents: -600 });
  });

  it("R10: income by category, Tax (ATO) stays negative", () => {
    const income = s.incomeByCategory.find(
      (t) => t.categoryId === cat("Income"),
    );
    expect(income?.cents).toBe(252634);
    const tax = income?.children.find(
      (t) => t.categoryId === cat("Income / Tax (ATO)"),
    );
    expect(tax?.cents).toBe(-90000);
  });

  it("R10: income by member", () => {
    expect(
      s.byMember.find((m) => m.memberId === mem("Female"))?.incomeCents,
    ).toBe(252634);
  });
});

describe("pivot：按周（R10.2）", () => {
  const p = pivot(
    jointSplits(),
    h.categories,
    SEPT,
    "week",
    "category",
    "expense",
  );

  it("R10.2: weeks start on Monday, first and last weeks are partial", () => {
    expect(p.columns).toEqual([
      { start: "2026-09-01", end: "2026-09-06", partial: true },
      { start: "2026-09-07", end: "2026-09-13", partial: false },
      { start: "2026-09-14", end: "2026-09-20", partial: false },
      { start: "2026-09-21", end: "2026-09-27", partial: false },
      { start: "2026-09-28", end: "2026-09-30", partial: true },
    ]);
  });

  it("R10.2: column totals 5840, 8580, -705, 21120, 10740 and grand total 45575", () => {
    expect(p.columnTotals).toEqual([5840, 8580, -705, 21120, 10740]);
    expect(p.total).toBe(45575);
  });

  it("R10.2: row totals add up and cells add up to column totals", () => {
    expect(p.rows.reduce((a, r) => a + r.total, 0)).toBe(p.total);
    p.columns.forEach((_, i) => {
      expect(p.rows.reduce((a, r) => a + r.cells[i], 0)).toBe(
        p.columnTotals[i],
      );
    });
    for (const r of p.rows) {
      expect(r.cells.reduce((a, c) => a + c, 0)).toBe(r.total);
    }
  });

  it("R10.2: category rows are first level, second level can be expanded", () => {
    const groceries = p.rows.find((r) => r.key === cat("Groceries"));
    expect(groceries?.cells).toEqual([5840, 6080, 3875, 0, 0]);
    expect(groceries?.total).toBe(15795);
    expect(groceries?.children.map((c) => c.key)).toEqual([
      cat("Groceries / Supermarket"),
    ]);
    expect(p.rows.map((r) => r.key)).not.toContain(cat("Uncategorised"));
  });

  it("R10.2: group by member", () => {
    const byMember = pivot(
      jointSplits(),
      h.categories,
      SEPT,
      "week",
      "member",
      "expense",
    );
    const male = byMember.rows.find((r) => r.key === mem("Male"));
    expect(male?.cells).toEqual([0, 0, 0, 0, 900]);
    expect(male?.children).toEqual([]);
    expect(byMember.columnTotals).toEqual([5840, 8580, -705, 21120, 10740]);
  });

  it("R10.2: a range that starts on Monday and ends on Sunday has no partial columns", () => {
    const r = periodRange(
      { start: "2026-09-07", end: "2026-09-20" },
      "2026-10-23",
    );
    const q = pivot(
      jointSplits(),
      h.categories,
      r,
      "week",
      "category",
      "expense",
    );
    expect(q.columns.map((c) => c.partial)).toEqual([false, false]);
  });
});

describe("pivot：按月（R10.2）", () => {
  it("R10.2: months, partial when the range does not cover the whole month", () => {
    const r = periodRange(
      { start: "2026-08-15", end: "2026-10-23" },
      "2026-10-23",
    );
    const p = pivot(
      jointSplits(),
      h.categories,
      r,
      "month",
      "member",
      "expense",
    );
    expect(p.columns).toEqual([
      { start: "2026-08-15", end: "2026-08-31", partial: true },
      { start: "2026-09-01", end: "2026-09-30", partial: false },
      { start: "2026-10-01", end: "2026-10-23", partial: true },
    ]);
    expect(p.columnTotals).toEqual([0, 45575, 0]);
  });

  it("R10.2: income metric uses income categories", () => {
    const splits = processed("cba/female-2026-09.csv", "CBA Female").map(
      toSplit,
    );
    const p = pivot(splits, h.categories, SEPT, "month", "category", "income");
    // 导入后未手动分类：1234 − 90000 + 400 + 41000
    expect(p.total).toBe(1234 - 90000 + 400 + 41000);
    expect(p.rows.map((r) => r.key)).toEqual([cat("Income")]);
  });
});

describe("budgetProgress（R11）", () => {
  const groceries = cat("Groceries");
  const budget = (
    categoryId: string,
    monthlyLimitCents: number,
    warnAtPercent = 80,
  ) => ({
    id: `budget:${categoryId}`,
    categoryId,
    monthlyLimitCents,
    warnAtPercent,
  });

  const progress = (b: ReturnType<typeof budget>, today = "2026-09-30") =>
    budgetProgress([b], jointSplits(), h.categories, today)[0];

  it("R11: first-level budget counts all its second-level spending", () => {
    const p = progress(budget(groceries, 20000));
    expect(p.spentCents).toBe(15795);
    expect(p.limitCents).toBe(20000);
    expect(p.percent).toBeCloseTo(78.975, 10);
    expect(p.level).toBe("ok");
  });

  it("R11: at or above warn_at_percent → warn", () => {
    expect(progress(budget(groceries, 19743)).level).toBe("warn"); // 80.002%
    expect(progress(budget(groceries, 19744)).level).toBe("ok"); // 79.998%
    expect(progress(budget(groceries, 15796)).level).toBe("warn");
  });

  it("R11: at or above 100% → over", () => {
    expect(progress(budget(groceries, 15795)).level).toBe("over");
    expect(progress(budget(groceries, 10000)).level).toBe("over");
  });

  it("R11: second-level budget counts only that subcategory", () => {
    const p = progress(
      budget(cat("Entertainment & eat-out / Bubble tea"), 1000),
    );
    expect(p.spentCents).toBe(900);
    expect(p.level).toBe("warn");
  });

  it("R11: refunds can make spending negative", () => {
    expect(progress(budget(cat("Personal & medical"), 5000)).spentCents).toBe(
      -4580,
    );
  });

  it("R11: only the calendar month of today counts", () => {
    expect(progress(budget(groceries, 20000), "2026-10-05").spentCents).toBe(0);
    // 9 月中旬：只算到目前为止已有的交易，整月范围
    expect(progress(budget(groceries, 20000), "2026-09-15").spentCents).toBe(
      15795,
    );
  });
});

// ---------- M5-1 看板（R10.3 到 R10.6） ----------
// 期望值来自 fixtures/README.md "看板"一节和 business-rules.md R10.3 到 R10.6

// fixtures 表里的 # 当作交易 id，每笔交易一个主拆分
function jointMerchantSplits(): MerchantSplit[] {
  return processed("anz/joint-2026-09.csv", "ANZ Joint").map((r, i) => ({
    ...toSplit(r),
    transactionId: `#${i + 1}`,
    merchant: r.merchant,
  }));
}

const GONG_CHA = "GONG CHA & HO/SPENCER ST MELBOURNE";

describe("topMerchants：joint-2026-09.csv 9 月（R10.3）", () => {
  const all = topMerchants(jointMerchantSplits(), h.categories, SEPT, 100);

  it("R10.3: top 5 by count, then amount", () => {
    expect(topMerchants(jointMerchantSplits(), h.categories, SEPT, 5)).toEqual([
      { merchant: GONG_CHA, count: 2, cents: 900 },
      { merchant: "ATM CBA HAWTHORN", count: 1, cents: 15000 },
      { merchant: "BPAY SEENE", count: 1, cents: 9840 },
      { merchant: "POCHANA MELBOURNE MELBOURNE", count: 1, cents: 6120 },
      { merchant: "MELB ASIAN MARKET", count: 1, cents: 6080 },
    ]);
  });

  it("R10.3: 6th onwards", () => {
    expect(all.slice(5)).toEqual([
      { merchant: "COLES 0559 MELBOURNE", count: 1, cents: 5840 },
      { merchant: "CROWN ASIAN SPENCER DOCKLANDS", count: 1, cents: 3875 },
      { merchant: "CHARGEFOX PTY LTD NORTH MELBOUR", count: 1, cents: 2500 },
      { merchant: "ACCOUNT SERVICING FEE", count: 1, cents: 500 },
    ]);
  });

  it("R10.3: refund-only merchants (count 0), uncategorised and transfers are not listed", () => {
    const names = all.map((m) => m.merchant);
    expect(names.some((n) => n.startsWith("REVERSAL"))).toBe(false);
    expect(names.some((n) => n.includes("MEDICARE"))).toBe(false);
    expect(names).toHaveLength(9);
  });

  it("R10.3: a refund only offsets the amount (MELB ASIAN MARKET -62.30 + 1.50 → 1, 60.80)", () => {
    expect(all.find((m) => m.merchant === "MELB ASIAN MARKET")).toEqual({
      merchant: "MELB ASIAN MARKET",
      count: 1,
      cents: 6080,
    });
  });
});

describe("topMerchants：一笔交易算一次（R10.3）", () => {
  const groceries = cat("Groceries / Supermarket");
  const household = cat("Home & utilities / Household supplies");
  const base = { date: "2026-09-10", memberId: mem("Home"), isPreTax: false };
  const split = (
    transactionId: string,
    merchant: string,
    amountCents: number,
    categoryId = groceries,
  ) =>
    ({
      ...base,
      transactionId,
      merchant,
      amountCents,
      categoryId,
    }) satisfies MerchantSplit;

  it("R10.3: expense splits of one transaction are added up and count once", () => {
    const r = topMerchants(
      [split("t1", "COLES", -3540), split("t1", "COLES", -1500, household)],
      h.categories,
      SEPT,
      5,
    );
    expect(r).toEqual([{ merchant: "COLES", count: 1, cents: 5040 }]);
  });

  it("R10.3: same count and amount → merchant name order", () => {
    const r = topMerchants(
      [split("t1", "WOOLWORTHS", -1000), split("t2", "ALDI", -1000)],
      h.categories,
      SEPT,
      5,
    );
    expect(r.map((m) => m.merchant)).toEqual(["ALDI", "WOOLWORTHS"]);
  });

  it("R10.3: outside the range is ignored", () => {
    const r = topMerchants(
      [{ ...split("t1", "COLES", -1000), date: "2026-10-01" }],
      h.categories,
      SEPT,
      5,
    );
    expect(r).toEqual([]);
  });
});

describe("filterByMember：选 Male（R10.6）", () => {
  const male = filterByMember(jointMerchantSplits(), mem("Male"));

  it("R10.6: expense is 900", () => {
    expect(summarize(male, h.categories, SEPT).expenseCents).toBe(900);
  });

  it("R10.6: top merchants only GONG CHA (2, 900)", () => {
    expect(topMerchants(male, h.categories, SEPT, 5)).toEqual([
      { merchant: GONG_CHA, count: 2, cents: 900 },
    ]);
  });

  it("R10.6: weekly pivot only has 900 in 9/28–9/30 (partial)", () => {
    const p = pivot(male, h.categories, SEPT, "week", "category", "expense");
    expect(p.columnTotals).toEqual([0, 0, 0, 0, 900]);
    expect(p.columns[4]).toEqual({
      start: "2026-09-28",
      end: "2026-09-30",
      partial: true,
    });
  });

  it("R10.6: grouped by member, still filtered → one row", () => {
    const p = pivot(male, h.categories, SEPT, "week", "member", "expense");
    expect(p.rows.map((r) => r.key)).toEqual([mem("Male")]);
  });

  it("R10.6: no member selected → all splits", () => {
    const all = jointMerchantSplits();
    expect(filterByMember(all, undefined)).toEqual(all);
  });
});

describe("pendingCount（R10.6）", () => {
  const p = (
    transactionId: string,
    status: PendingSplit["status"],
    date = "2026-09-10",
  ) => ({ transactionId, status, date }) satisfies PendingSplit;

  it("R10.6: counts pending transactions in range, a transaction with several splits once", () => {
    expect(
      pendingCount(
        [
          p("t1", "pending"),
          p("t1", "pending"),
          p("t2", "pending"),
          p("t3", "confirmed"),
        ],
        SEPT,
      ),
    ).toBe(2);
  });

  it("R10.6: outside the range is not counted", () => {
    expect(pendingCount([p("t1", "pending", "2026-10-01")], SEPT)).toBe(0);
  });

  it("R10.6: only splits matching the member filter count", () => {
    const splits = [
      { ...p("t1", "pending"), memberId: mem("Male") },
      { ...p("t1", "pending"), memberId: mem("Home") },
      { ...p("t2", "pending"), memberId: mem("Female") },
    ];
    expect(pendingCount(filterByMember(splits, mem("Male")), SEPT)).toBe(1);
  });
});

describe("compare（R10.4）", () => {
  const s = (incomeCents: number, expenseCents: number) => ({
    incomeCents,
    expenseCents,
  });

  it("R10.4: expense 400.00 → 455.75 is +14%", () => {
    expect(compare(s(0, 45575), s(0, 40000)).expensePercent).toBe(14);
  });

  it("R10.4: savings rate 21.8% → 25.0% is +3 pp", () => {
    expect(compare(s(100000, 75000), s(100000, 78200)).savingsRatePoints).toBe(
      3,
    );
  });

  it("R10.4: -12.5% rounds away from zero to -13%", () => {
    expect(compare(s(35000, 0), s(40000, 0)).incomePercent).toBe(-13);
  });

  it('R10.4: previous is 0 → null ("—")', () => {
    expect(compare(s(100000, 50000), s(0, 0))).toEqual({
      incomePercent: null,
      expensePercent: null,
      savingsRatePoints: null,
    });
  });

  it("R10.4: previous income is negative (tax paid) → null", () => {
    expect(
      compare(s(100000, 50000), s(-90000, 50000)).incomePercent,
    ).toBeNull();
  });

  it('R10.4: savings rate "—" in either period → null', () => {
    expect(compare(s(0, 50000), s(100000, 50000)).savingsRatePoints).toBeNull();
    expect(compare(s(100000, 50000), s(0, 50000)).savingsRatePoints).toBeNull();
  });

  it('R10.4: joint-2026-09 vs previous period (no data) → all "—"', () => {
    const cur = summarize(jointSplits(), h.categories, SEPT);
    const prev = summarize(jointSplits(), h.categories, previousPeriod(SEPT));
    expect(compare(cur, prev)).toEqual({
      incomePercent: null,
      expensePercent: null,
      savingsRatePoints: null,
    });
  });
});

describe("monthlyTrend：joint-2026-09.csv，今天 2026-10-24（R10.5）", () => {
  const months = lastTwelveMonths("2026-10-24");
  const t = monthlyTrend(jointSplits(), h.categories, months);

  it("R10.5: 12 months, empty months are 0 not skipped", () => {
    expect(t).toHaveLength(12);
    expect(t.filter((m) => m.start !== "2026-09-01")).toEqual(
      months
        .filter((m) => m.start !== "2026-09-01")
        .map((m) => ({ ...m, incomeCents: 0, expenseCents: 0, netCents: 0 })),
    );
  });

  it("R10.5: 2026-09 income 0, expense 45575, net -45575", () => {
    expect(t[10]).toEqual({
      start: "2026-09-01",
      end: "2026-09-30",
      incomeCents: 0,
      expenseCents: 45575,
      netCents: -45575,
    });
  });
});
