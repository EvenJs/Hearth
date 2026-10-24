import { describe, expect, it } from "vitest";
import { periodRange } from "@/lib/rules/periods";
import { pivotColumns } from "@/lib/rules/stats";
import {
  filtersToSearchParams,
  type TransactionFilters,
} from "@/lib/transactions/filters";
import {
  categoryLink,
  kpiLink,
  merchantLink,
  pivotCellLink,
  trendMonthLink,
  type DashboardScope,
} from "./links";

// 看板点击 → F8 筛选条件（prd.md F6、business-rules.md R10.2、R10.6、R16.5；docs/tasks/m5.md M5-1）

const MALE = "22222222-2222-4222-8222-222222222222";
const CATEGORY = "33333333-3333-4333-8333-333333333333";
const TODAY = "2026-10-24";
const SEPT = periodRange({ start: "2026-09-01", end: "2026-09-30" }, TODAY);
const SEPT_RANGE = { start: "2026-09-01", end: "2026-09-30" };

const all: DashboardScope = { period: SEPT };
const male: DashboardScope = { period: SEPT, memberId: MALE };

describe("kpiLink", () => {
  it("income / expense → type filter with the period", () => {
    expect(kpiLink(all, "income")).toEqual<TransactionFilters>({
      period: SEPT_RANGE,
      type: "income",
    });
    expect(kpiLink(all, "expense")).toEqual<TransactionFilters>({
      period: SEPT_RANGE,
      type: "expense",
    });
  });

  it("uncategorised → quick filter; pending → status", () => {
    expect(kpiLink(all, "uncategorized")).toEqual({
      period: SEPT_RANGE,
      quick: "uncategorized",
    });
    expect(kpiLink(all, "pending")).toEqual({
      period: SEPT_RANGE,
      status: "pending",
    });
  });

  it("R10.6: the member filter is carried along", () => {
    expect(kpiLink(male, "expense")).toEqual({
      period: SEPT_RANGE,
      memberId: MALE,
      type: "expense",
    });
  });

  it("a preset period stays a preset (same URL as the dashboard)", () => {
    const scope = { period: periodRange("this_month", TODAY) };
    expect(kpiLink(scope, "income").period).toBe("this_month");
    expect(filtersToSearchParams(kpiLink(scope, "income")).toString()).toBe(
      "period=this_month&type=income",
    );
  });
});

describe("categoryLink / merchantLink", () => {
  it("category row → categoryId (first level includes its children in F8)", () => {
    expect(categoryLink(male, CATEGORY)).toEqual({
      period: SEPT_RANGE,
      memberId: MALE,
      categoryId: CATEGORY,
    });
  });

  it("R10.3: merchant → merchant keyword, expense type only", () => {
    expect(merchantLink(all, "MELB ASIAN MARKET")).toEqual({
      period: SEPT_RANGE,
      merchant: "MELB ASIAN MARKET",
      type: "expense",
    });
  });
});

describe("pivotCellLink（R10.2）", () => {
  const columns = pivotColumns(SEPT, "week");

  it("R10.2: a partial week cell only covers the days inside the period (9/28–9/30)", () => {
    expect(
      pivotCellLink(all, {
        column: columns[4],
        groupBy: "category",
        rowKey: CATEGORY,
        metric: "expense",
      }),
    ).toEqual({
      period: { start: "2026-09-28", end: "2026-09-30" },
      categoryId: CATEGORY,
      type: "expense",
    });
  });

  it("R10.2: first partial week is 9/1–9/6", () => {
    expect(
      pivotCellLink(all, {
        column: columns[0],
        groupBy: "category",
        rowKey: null,
        metric: "expense",
      }).period,
    ).toEqual({ start: "2026-09-01", end: "2026-09-06" });
  });

  it("R10.2: row total (no column) uses the whole period", () => {
    expect(
      pivotCellLink(all, {
        column: null,
        groupBy: "category",
        rowKey: CATEGORY,
        metric: "income",
      }),
    ).toEqual({ period: SEPT_RANGE, categoryId: CATEGORY, type: "income" });
  });

  it("R10.2: column total (no row) has no group filter", () => {
    expect(
      pivotCellLink(all, {
        column: columns[2],
        groupBy: "category",
        rowKey: null,
        metric: "expense",
      }),
    ).toEqual({
      period: { start: "2026-09-14", end: "2026-09-20" },
      type: "expense",
    });
  });

  it("R10.2: grouped by member → memberId of the row", () => {
    expect(
      pivotCellLink(all, {
        column: columns[4],
        groupBy: "member",
        rowKey: MALE,
        metric: "expense",
      }),
    ).toEqual({
      period: { start: "2026-09-28", end: "2026-09-30" },
      memberId: MALE,
      type: "expense",
    });
  });

  it("R10.6: member filter is kept on category cells", () => {
    expect(
      pivotCellLink(male, {
        column: columns[4],
        groupBy: "category",
        rowKey: CATEGORY,
        metric: "expense",
      }),
    ).toEqual({
      period: { start: "2026-09-28", end: "2026-09-30" },
      memberId: MALE,
      categoryId: CATEGORY,
      type: "expense",
    });
  });
});

describe("trendMonthLink（R10.5）", () => {
  it("R10.5: a month → that month range, not the selected period", () => {
    expect(
      trendMonthLink(
        male,
        { start: "2026-10-01", end: "2026-10-24" },
        "expense",
      ),
    ).toEqual({
      period: { start: "2026-10-01", end: "2026-10-24" },
      memberId: MALE,
      type: "expense",
    });
  });

  it("R10.5: without a metric → all types (net)", () => {
    expect(
      trendMonthLink(all, { start: "2026-09-01", end: "2026-09-30" }),
    ).toEqual({
      period: SEPT_RANGE,
    });
  });
});
