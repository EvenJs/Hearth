// 在职段折算工资和已代扣（business-rules.md R14.9）
// 日期是 YYYY-MM-DD 字符串，天数用 periods.ts 的工具算，不转 JS Date
// 纯函数，不 import 数据库和 Next.js
import { daysBetween } from '@/lib/rules/periods';
import { financialYearRange, getTaxRates, totalTaxCents } from './rates';

// 年薪税前、不含 super；endDate 为空 = 还在职
export type TaxJob = { annualSalaryCents: number; startDate: string; endDate: string | null };

// R14.9：365，包含 2 月 29 日的是 366
export function financialYearDays(financialYear: number): number {
  const { start, end } = financialYearRange(financialYear);
  return daysBetween(start, end) + 1;
}

// R14.9：[开始, 结束] ∩ 财年，两头都算；结束为空 = 财年底；不相交 = 0
export function jobDaysInYear(job: TaxJob, financialYear: number): number {
  const fy = financialYearRange(financialYear);
  const start = job.startDate > fy.start ? job.startDate : fy.start;
  const end = job.endDate !== null && job.endDate < fy.end ? job.endDate : fy.end;
  return start > end ? 0 : daysBetween(start, end) + 1;
}

// R14.9：年薪 × 天数 ÷ 财年天数，四舍五入到分。不用税率表，没有表的财年也能算
export function proratedSalaryCents(job: TaxJob, financialYear: number): number {
  return Math.round(
    (job.annualSalaryCents * jobDaysInYear(job, financialYear)) / financialYearDays(financialYear),
  );
}

export type ProratedJob<T extends TaxJob> = {
  job: T;
  days: number;
  grossCents: number;
  withheldCents: number;
};

// R14.9：每份工作分别四舍五入到分，再加起来，设置页每行的数加起来等于合计
// 折算已代扣 = total(年薪) × 天数 ÷ 财年天数；财年没有税率表时报错（R14.7）
export function prorateJobs<T extends TaxJob>(
  jobs: readonly T[],
  financialYear: number,
): { jobs: ProratedJob<T>[]; grossCents: number; withheldCents: number } {
  getTaxRates(financialYear);
  const yearDays = financialYearDays(financialYear);

  const prorated = jobs.map((job): ProratedJob<T> => {
    const days = jobDaysInYear(job, financialYear);
    // total(年薪)：把年薪当 taxable，先取整元
    const fullYearTax = totalTaxCents(Math.floor(job.annualSalaryCents / 100), financialYear);
    return {
      job,
      days,
      grossCents: Math.round((job.annualSalaryCents * days) / yearDays),
      withheldCents: Math.round((fullYearTax * days) / yearDays),
    };
  });

  return {
    jobs: prorated,
    grossCents: prorated.reduce((a, j) => a + j.grossCents, 0),
    withheldCents: prorated.reduce((a, j) => a + j.withheldCents, 0),
  };
}
