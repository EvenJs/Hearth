// 个人所得税税率表（business-rules.md R14.4），resident，不含 Medicare levy
// 按财年存，用开始年份表示：2026 = 2026-27。新财年要手动加，没有时报错，不沿用旧表
// 纯函数，不 import 数据库和 Next.js
import type { DateRange } from '@/lib/rules/periods';

// 应纳税收入超过 fromDollars 的部分按 ratePercent 计税，直到下一档的 fromDollars
export type TaxBracket = { fromDollars: number; ratePercent: number };

const RATES: Record<number, readonly TaxBracket[]> = {
  2025: [
    { fromDollars: 0, ratePercent: 0 },
    { fromDollars: 18200, ratePercent: 16 },
    { fromDollars: 45000, ratePercent: 30 },
    { fromDollars: 135000, ratePercent: 37 },
    { fromDollars: 190000, ratePercent: 45 },
  ],
  2026: [
    { fromDollars: 0, ratePercent: 0 },
    { fromDollars: 18200, ratePercent: 15 },
    { fromDollars: 45000, ratePercent: 30 },
    { fromDollars: 135000, ratePercent: 37 },
    { fromDollars: 190000, ratePercent: 45 },
  ],
  // 2027-28 起第二档降到 14%，其他档开工时再确认后加入（R14.4）
};

// Medicare levy 2%（R14.3）
export const MEDICARE_PERCENT = 2;

// R14.1：2026 → "2026-27"
export function financialYearLabel(financialYear: number): string {
  return `${financialYear}-${String((financialYear + 1) % 100).padStart(2, '0')}`;
}

// R14.1：2026 → 2026-07-01 到 2027-06-30
export function financialYearRange(financialYear: number): DateRange {
  return { start: `${financialYear}-07-01`, end: `${financialYear + 1}-06-30` };
}

// R14.7：有税率表的财年，从新到旧。设置页的财年下拉只列这些
export function availableFinancialYears(): number[] {
  return Object.keys(RATES)
    .map(Number)
    .sort((a, b) => b - a);
}

export function getTaxRates(financialYear: number): readonly TaxBracket[] {
  const rates = RATES[financialYear];
  if (!rates) {
    throw new Error(
      `没有 ${financialYearLabel(financialYear)} 财年的税率表，请先在 src/lib/tax/rates.ts 加上`,
    );
  }
  return rates;
}

// R14.3：按当年税率表分档计算，输入是整元，返回分
export function incomeTaxCents(taxableDollars: number, financialYear: number): number {
  const brackets = getTaxRates(financialYear);
  let cents = 0;
  brackets.forEach((b, i) => {
    const upper = brackets[i + 1]?.fromDollars ?? Infinity;
    const portion = Math.min(taxableDollars, upper) - b.fromDollars;
    if (portion > 0) cents += portion * b.ratePercent; // 元 × % = 分
  });
  return cents;
}

// R14.3：incomeTax + medicare。R14.9 的 total(年薪) 也用这个
export function totalTaxCents(taxableDollars: number, financialYear: number): number {
  return incomeTaxCents(taxableDollars, financialYear) + taxableDollars * MEDICARE_PERCENT;
}
