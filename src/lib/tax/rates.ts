// 个人所得税税率表（business-rules.md R14.4），resident，不含 Medicare levy
// 按财年存，用开始年份表示：2026 = 2026-27。新财年要手动加，没有时报错，不沿用旧表
// 纯函数，不 import 数据库和 Next.js

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

export function getTaxRates(financialYear: number): readonly TaxBracket[] {
  const rates = RATES[financialYear];
  if (!rates) {
    throw new Error(
      `没有 ${financialYear}-${String((financialYear + 1) % 100).padStart(2, '0')} 财年的税率表，请先在 src/lib/tax/rates.ts 加上`,
    );
  }
  return rates;
}
