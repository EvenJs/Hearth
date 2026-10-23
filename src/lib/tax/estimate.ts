// 税后估算（business-rules.md R14）。只是估算，不是税务建议
// 金额全程是整数分；taxable 是整元，整元 × 百分比 = 整数分，不需要再四舍五入
// 纯函数，不 import 数据库和 Next.js
import type { DateRange } from '@/lib/rules/periods';
import type { StatSplit } from '@/lib/rules/stats';
import type { Member } from '@/lib/rules/types';
import { getTaxRates, MEDICARE_PERCENT } from './rates';

// ---------- R14.1 财年 ----------

// 7 月 1 日到次年 6 月 30 日，用开始年份表示
export function financialYearOf(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= 7 ? year : year - 1;
}

export function financialYearRange(financialYear: number): DateRange {
  return { start: `${financialYear}-07-01`, end: `${financialYear + 1}-06-30` };
}

function inYear(date: string, financialYear: number): boolean {
  const { start, end } = financialYearRange(financialYear);
  return date >= start && date <= end;
}

// ---------- R14.2 每人的税前收入 ----------

// members 的顺序就是排序（调用方按 sort_order 排好），平分除不尽的分给排在前面的 person
// 返回每个 person 的税前收入；shared 和 child 不出现在结果里
export function preTaxIncomeByPerson(
  splits: readonly StatSplit[],
  members: readonly Member[],
  financialYear: number,
): Map<string, number> {
  const persons = members.filter((m) => m.kind === 'person');
  const sharedIds = new Set(members.filter((m) => m.kind === 'shared').map((m) => m.id));
  const result = new Map(persons.map((p) => [p.id, 0]));

  let sharedCents = 0;
  for (const s of splits) {
    if (!s.isPreTax || !inYear(s.date, financialYear)) continue;
    if (result.has(s.memberId)) result.set(s.memberId, result.get(s.memberId)! + s.amountCents);
    else if (sharedIds.has(s.memberId)) sharedCents += s.amountCents;
  }

  // 平分 shared：余数（可能是负的）一分一分给排在前面的人
  if (persons.length > 0 && sharedCents !== 0) {
    const base = Math.trunc(sharedCents / persons.length);
    let remainder = sharedCents - base * persons.length;
    for (const p of persons) {
      const extra = Math.sign(remainder);
      result.set(p.id, result.get(p.id)! + base + extra);
      remainder -= extra;
    }
  }

  return result;
}

// ---------- R14.3 计算 ----------

// 按当年税率表分档计算，输入是整元，返回分
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

export type TaxProfileAmounts = { paygGrossCents: number; paygWithheldCents: number };

export type TaxEstimate = {
  hasProfile: boolean; // false 时界面提示去设置页填（R14.6），仍按 payg 为 0 计算
  preTaxIncomeCents: number;
  taxableDollars: number;
  incomeTaxCents: number;
  medicareCents: number;
  totalCents: number;
  paygWithheldCents: number;
  prepaidCents: number;
  owingCents: number; // 负数表示预计退税
};

export function calculateTax(input: {
  financialYear: number;
  preTaxIncomeCents: number;
  profile: TaxProfileAmounts | null;
  prepaidCents: number;
}): TaxEstimate {
  const { financialYear, preTaxIncomeCents, profile, prepaidCents } = input;
  const paygGross = profile?.paygGrossCents ?? 0;
  const paygWithheld = profile?.paygWithheldCents ?? 0;

  // 先向下取整到整元；税前收入为负（极少见）时不低于 0
  const taxableDollars = Math.max(0, Math.floor((paygGross + preTaxIncomeCents) / 100));
  const incomeTax = incomeTaxCents(taxableDollars, financialYear);
  const medicare = taxableDollars * MEDICARE_PERCENT;
  const total = incomeTax + medicare;

  return {
    hasProfile: profile !== null,
    preTaxIncomeCents,
    taxableDollars,
    incomeTaxCents: incomeTax,
    medicareCents: medicare,
    totalCents: total,
    paygWithheldCents: paygWithheld,
    prepaidCents,
    owingCents: total - paygWithheld - prepaidCents,
  };
}

// ---------- 整个家庭 ----------

export type TaxProfile = TaxProfileAmounts & { memberId: string; financialYear: number };

export type MemberTaxEstimate = TaxEstimate & { memberId: string };

// R14.6：每个 person 一张卡片，按 members 的顺序
// taxCategoryId 是 Income / Tax (ATO) 二级分类的 id
export function estimateHouseholdTax(input: {
  splits: readonly StatSplit[];
  members: readonly Member[];
  profiles: readonly TaxProfile[];
  taxCategoryId: string;
  financialYear: number;
}): MemberTaxEstimate[] {
  const { splits, members, profiles, taxCategoryId, financialYear } = input;
  // 先检查税率表，没有就直接报错
  getTaxRates(financialYear);

  const preTax = preTaxIncomeByPerson(splits, members, financialYear);

  return members
    .filter((m) => m.kind === 'person')
    .map((m) => {
      const profile =
        profiles.find((p) => p.memberId === m.id && p.financialYear === financialYear) ?? null;

      // prepaid = −Σ 该人 Tax (ATO) 的负数拆分，退税（正数）不算
      const prepaidCents = splits
        .filter(
          (s) =>
            s.memberId === m.id &&
            s.categoryId === taxCategoryId &&
            s.amountCents < 0 &&
            inYear(s.date, financialYear),
        )
        .reduce((a, s) => a - s.amountCents, 0); // 从 0 往下减，避免 -0

      return {
        memberId: m.id,
        ...calculateTax({
          financialYear,
          preTaxIncomeCents: preTax.get(m.id) ?? 0,
          profile,
          prepaidCents,
        }),
      };
    });
}
