import { describe, expect, it } from "vitest";
import {
  addDays,
  lastTwelveMonths,
  periodRange,
  previousPeriod,
  todayInMelbourne,
  type PresetPeriod,
} from "./periods";

// 期望值来自 business-rules.md R10.1 和 docs/tasks/m2.md M2-11
// 上一期：按日历单位往前挪（周 7 天，月 1 个月，季度 3 个月，年和财年 1 年），原来到月底的仍到月底；自定义取紧挨着的同天数

const range = (start: string, end: string) => ({ start, end });

describe("periodRange（R10.1）", () => {
  // 2026-10-23 是周五
  it.each<[PresetPeriod, string, string, string]>([
    ["this_week", "2026-10-23", "2026-10-19", "2026-10-23"],
    ["this_week", "2026-10-19", "2026-10-19", "2026-10-19"], // 周一
    ["this_week", "2026-10-25", "2026-10-19", "2026-10-25"], // 周日
    ["this_week", "2027-01-01", "2026-12-28", "2027-01-01"], // 跨年
    ["last_week", "2026-10-23", "2026-10-12", "2026-10-18"],
    ["last_week", "2026-10-19", "2026-10-12", "2026-10-18"],
    ["last_week", "2026-10-25", "2026-10-12", "2026-10-18"],
    ["last_week", "2027-01-01", "2026-12-21", "2026-12-27"],
    ["this_month", "2026-10-23", "2026-10-01", "2026-10-23"],
    ["this_month", "2026-10-01", "2026-10-01", "2026-10-01"],
    ["last_month", "2026-10-23", "2026-09-01", "2026-09-30"],
    ["last_month", "2027-01-15", "2026-12-01", "2026-12-31"],
    ["last_month", "2028-03-10", "2028-02-01", "2028-02-29"],
    ["this_quarter", "2026-10-23", "2026-10-01", "2026-10-23"],
    ["this_quarter", "2027-02-15", "2027-01-01", "2027-02-15"],
    ["this_quarter", "2027-06-30", "2027-04-01", "2027-06-30"],
    ["this_quarter", "2026-09-30", "2026-07-01", "2026-09-30"],
    ["this_year", "2026-10-23", "2026-01-01", "2026-10-23"],
    ["this_fy", "2026-10-22", "2026-07-01", "2026-10-22"],
    ["this_fy", "2027-03-01", "2026-07-01", "2027-03-01"],
    ["this_fy", "2026-07-01", "2026-07-01", "2026-07-01"],
    ["this_fy", "2026-06-30", "2025-07-01", "2026-06-30"],
  ])("R10.1: %s with today %s → %s to %s", (option, today, start, end) => {
    expect(periodRange(option, today)).toEqual({ option, start, end });
  });

  it("R10.1: custom range includes both ends", () => {
    expect(
      periodRange({ start: "2026-09-01", end: "2026-09-30" }, "2026-10-23"),
    ).toEqual({
      option: "custom",
      start: "2026-09-01",
      end: "2026-09-30",
    });
    expect(
      periodRange({ start: "2026-09-05", end: "2026-09-05" }, "2026-10-23").end,
    ).toBe("2026-09-05");
  });

  it("R10.1: custom range with start after end is rejected", () => {
    expect(() =>
      periodRange({ start: "2026-09-30", end: "2026-09-01" }, "2026-10-23"),
    ).toThrow();
  });

  it.each(["2026-02-30", "2026-9-1", "01/09/2026", ""])(
    "R10.1: invalid date %j is rejected",
    (d) => {
      expect(() => periodRange("this_month", d)).toThrow();
      expect(() =>
        periodRange({ start: d, end: "2026-09-30" }, "2026-10-23"),
      ).toThrow();
    },
  );
});

describe("previousPeriod（R10.1 对比上一期）", () => {
  it("R10.1: this month 1–21 compares with last month 1–21", () => {
    expect(previousPeriod(periodRange("this_month", "2026-10-21"))).toEqual(
      range("2026-09-01", "2026-09-21"),
    );
  });

  it.each([
    ["2026-10-23", "2026-09-01", "2026-09-23"],
    ["2026-10-31", "2026-09-01", "2026-09-30"], // 10/31 → 9 月没有 31 日，截到月底
    ["2026-03-31", "2026-02-01", "2026-02-28"],
    ["2026-03-30", "2026-02-01", "2026-02-28"],
    ["2026-01-15", "2025-12-01", "2025-12-15"],
  ])("R10.1: this_month today %s → %s to %s", (today, start, end) => {
    expect(previousPeriod(periodRange("this_month", today))).toEqual(
      range(start, end),
    );
  });

  it.each([
    ["2026-10-23", "2026-08-01", "2026-08-31"], // 上月 9/1–9/30 → 8/1–8/31
    ["2026-04-10", "2026-02-01", "2026-02-28"], // 3/1–3/31 → 2/1–2/28
    ["2028-04-10", "2028-02-01", "2028-02-29"],
    ["2026-03-10", "2026-01-01", "2026-01-31"], // 2/1–2/28 → 1/1–1/31
  ])("R10.1: last_month today %s → %s to %s", (today, start, end) => {
    expect(previousPeriod(periodRange("last_month", today))).toEqual(
      range(start, end),
    );
  });

  it("R10.1: weeks shift back 7 days", () => {
    expect(previousPeriod(periodRange("this_week", "2026-10-23"))).toEqual(
      range("2026-10-12", "2026-10-16"),
    );
    expect(previousPeriod(periodRange("last_week", "2026-10-23"))).toEqual(
      range("2026-10-05", "2026-10-11"),
    );
    expect(previousPeriod(periodRange("this_week", "2027-01-01"))).toEqual(
      range("2026-12-21", "2026-12-25"),
    );
  });

  it("R10.1: quarter shifts back 3 months", () => {
    expect(previousPeriod(periodRange("this_quarter", "2026-10-23"))).toEqual(
      range("2026-07-01", "2026-07-23"),
    );
    expect(previousPeriod(periodRange("this_quarter", "2027-02-15"))).toEqual(
      range("2026-10-01", "2026-11-15"),
    );
    expect(previousPeriod(periodRange("this_quarter", "2026-09-30"))).toEqual(
      range("2026-04-01", "2026-06-30"),
    );
  });

  it("R10.1: year and financial year shift back 1 year", () => {
    expect(previousPeriod(periodRange("this_year", "2026-10-23"))).toEqual(
      range("2025-01-01", "2025-10-23"),
    );
    expect(previousPeriod(periodRange("this_year", "2028-02-29"))).toEqual(
      range("2027-01-01", "2027-02-28"),
    );
    expect(previousPeriod(periodRange("this_fy", "2026-10-22"))).toEqual(
      range("2025-07-01", "2025-10-22"),
    );
    expect(previousPeriod(periodRange("this_fy", "2027-03-01"))).toEqual(
      range("2025-07-01", "2026-03-01"),
    );
  });

  it("R10.1: custom range uses the same number of days right before it", () => {
    const custom = periodRange(
      { start: "2026-09-10", end: "2026-09-30" },
      "2026-10-23",
    );
    expect(previousPeriod(custom)).toEqual(range("2026-08-20", "2026-09-09"));
    const oneDay = periodRange(
      { start: "2026-03-01", end: "2026-03-01" },
      "2026-10-23",
    );
    expect(previousPeriod(oneDay)).toEqual(range("2026-02-28", "2026-02-28"));
  });
});

describe("addDays", () => {
  it.each([
    ["2026-09-30", 1, "2026-10-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2026-10-23", -7, "2026-10-16"],
  ])("%s + %i → %s", (d, n, out) => {
    expect(addDays(d, n)).toBe(out);
  });
});

describe("todayInMelbourne（R10.1 今天按 Australia/Melbourne）", () => {
  it("R10.1: UTC afternoon is already next day in Melbourne", () => {
    // 2026-10-22 14:30 UTC = 2026-10-23 01:30 AEDT
    expect(todayInMelbourne(new Date("2026-10-22T14:30:00Z"))).toBe(
      "2026-10-23",
    );
    expect(todayInMelbourne(new Date("2026-10-22T12:00:00Z"))).toBe(
      "2026-10-22",
    );
    // 冬令时 AEST +10：2026-06-30 14:30 UTC = 07-01 00:30
    expect(todayInMelbourne(new Date("2026-06-30T14:30:00Z"))).toBe(
      "2026-07-01",
    );
  });
});

describe("lastTwelveMonths（R10.5）", () => {
  it("R10.5: today 2026-10-24 → 2025-11-01 … 2026-10-24, last month only to today", () => {
    const months = lastTwelveMonths("2026-10-24");
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ start: "2025-11-01", end: "2025-11-30" });
    expect(months[11]).toEqual({ start: "2026-10-01", end: "2026-10-24" });
  });

  it("R10.5: consecutive natural months, February in a leap year", () => {
    const months = lastTwelveMonths("2028-03-01");
    expect(months[0]).toEqual({ start: "2027-04-01", end: "2027-04-30" });
    expect(months[10]).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(months[11]).toEqual({ start: "2028-03-01", end: "2028-03-01" });
    for (let i = 1; i < 12; i++)
      expect(months[i].start).toBe(addDays(months[i - 1].end, 1));
  });
});
