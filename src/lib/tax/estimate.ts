// 税后估算（business-rules.md R14）。只是估算，不是税务建议
// 金额全程是整数分；taxable 是整元，整元 × 百分比 = 整数分，不需要再四舍五入
// 纯函数，不 import 数据库和 Next.js
import type { StatSplit } from '@/lib/rules/stats';
import type { Member } from '@/lib/rules/types';
import { prorateJobs, type TaxJob } from './jobs';
import { financialYearRange, getTaxRates, incomeTaxCents, MEDICARE_PERCENT } from './rates';

export { financialYearRange, incomeTaxCents };

// ---------- R14.1 财年 ----------

// 7 月 1 日到次年 6 月 30 日，用开始年份表示
export function financialYearOf(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= 7 ? year : year - 1;
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

// tax_profile 的实际数，每一格为空 = 没填（R14.3、R14.10）
export type TaxProfileAmounts = {
  paygGrossCents: number | null;
  paygWithheldCents: number | null;
  expectedInterestCents?: number | null;
};

export type AmountSource = 'actual' | 'prorated';

export type TaxEstimate = {
  hasProfile: boolean; // 这个财年有 tax_profile 行（R14.8 清除按钮）
  // R14.6：这个财年有在职段落进来，或填了工资总额。false 时卡片大字"还没填工资"
  hasSalaryInfo: boolean;
  paygGrossCents: number;
  paygGrossSource: AmountSource;
  paygWithheldSource: AmountSource;
  interestReceivedCents: number; // R14.10 已到账利息
  interestCents: number; // R14.10 利息部分
  interestSource: 'expected' | 'received';
  // R14.6：没填预计全年利息、已到账 > 0，卡片底部小字"利息只算到 MM-DD"
  interestPartial: boolean;
  preTaxIncomeCents: number; // R14.10 换过利息部分之后的
  taxableDollars: number;
  incomeTaxCents: number;
  medicareCents: number;
  totalCents: number;
  paygWithheldCents: number;
  prepaidCents: number;
  owingCents: number; // 负数表示预计退税
};

// preTaxIncomeCents 是 R14.2 的税前收入，里面已含 interestReceivedCents
// jobs 是这个人的在职段（R14.9），不按财年筛，这里算天数
export function calculateTax(input: {
  financialYear: number;
  preTaxIncomeCents: number;
  interestReceivedCents?: number;
  profile: TaxProfileAmounts | null;
  jobs?: readonly TaxJob[];
  prepaidCents: number;
}): TaxEstimate {
  const { financialYear, profile, prepaidCents } = input;
  const jobs = input.jobs ?? [];
  const interestReceived = input.interestReceivedCents ?? 0;

  // R14.3：实际数各自不为空就用，为空用 R14.9 折算
  const prorated = prorateJobs(jobs, financialYear);
  const actualGross = profile?.paygGrossCents ?? null;
  const actualWithheld = profile?.paygWithheldCents ?? null;
  const paygGross = actualGross ?? prorated.grossCents;
  const paygWithheld = actualWithheld ?? prorated.withheldCents;

  // R14.10：利息部分 = max(预计, 已到账)，没填预计就是已到账
  const expectedInterest = profile?.expectedInterestCents ?? null;
  const interest =
    expectedInterest === null ? interestReceived : Math.max(expectedInterest, interestReceived);
  const preTaxIncomeCents = input.preTaxIncomeCents - interestReceived + interest;

  // 先向下取整到整元；税前收入为负（极少见）时不低于 0
  const taxableDollars = Math.max(0, Math.floor((paygGross + preTaxIncomeCents) / 100));
  const incomeTax = incomeTaxCents(taxableDollars, financialYear);
  const medicare = taxableDollars * MEDICARE_PERCENT;
  const total = incomeTax + medicare;

  return {
    hasProfile: profile !== null,
    // R14.6：只填已代扣不算；工资总额填 0 算填过
    hasSalaryInfo: actualGross !== null || prorated.jobs.some((j) => j.days > 0),
    paygGrossCents: paygGross,
    paygGrossSource: actualGross === null ? 'prorated' : 'actual',
    paygWithheldSource: actualWithheld === null ? 'prorated' : 'actual',
    interestReceivedCents: interestReceived,
    interestCents: interest,
    interestSource:
      expectedInterest !== null && expectedInterest > interestReceived ? 'expected' : 'received',
    interestPartial: expectedInterest === null && interestReceived > 0,
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

export type MemberTaxJob = TaxJob & { memberId: string };

export type MemberTaxEstimate = TaxEstimate & { memberId: string };

// R14.6：每个 person 一张卡片，按 members 的顺序
// taxCategoryId 是 Income / Tax (ATO) 二级分类的 id，interestCategoryId 是 Income / Interest 的
// jobs 是全部在职段，不按财年筛（R14.9）
export function estimateHouseholdTax(input: {
  splits: readonly StatSplit[];
  members: readonly Member[];
  profiles: readonly TaxProfile[];
  jobs?: readonly MemberTaxJob[];
  taxCategoryId: string;
  interestCategoryId?: string;
  financialYear: number;
}): MemberTaxEstimate[] {
  const { splits, members, profiles, taxCategoryId, financialYear } = input;
  const jobs = input.jobs ?? [];
  // 先检查税率表，没有就直接报错
  getTaxRates(financialYear);

  const preTax = preTaxIncomeByPerson(splits, members, financialYear);
  // R14.10：已到账利息 = R14.2 里 Income / Interest 的部分，Home 的照样平分
  const interest = preTaxIncomeByPerson(
    splits.filter((s) => s.categoryId === input.interestCategoryId),
    members,
    financialYear,
  );

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
          interestReceivedCents: interest.get(m.id) ?? 0,
          profile,
          jobs: jobs.filter((j) => j.memberId === m.id),
          prepaidCents,
        }),
      };
    });
}
