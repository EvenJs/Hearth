// 防漏导（business-rules.md R12.2 前两条）：上次导到哪天、建议导出范围、对账单导到哪天；CSV 导入后的空档警告
// 日期都是 YYYY-MM-DD 字符串，可以直接比较，不转 JS Date
// 纯函数，不 import 数据库和 Next.js
import { addDays } from '@/lib/rules/periods';

export type CoverageBatch = { source: 'csv' | 'pdf'; dateTo: string };

export type ImportCoverage = {
  lastDateTo: string | null; // X：所有批次里最大的 date_to。null = 没导入过，不显示
  suggestedFrom: string | null; // X − 7 天：故意重叠一周，晚入账的补上，重复的 R4 跳过
  suggestedTo: string | null; // 今天（Australia/Melbourne）
  statementDateTo: string | null; // source = pdf 的最大 date_to："对账单已经导到 B"
};

// CSV 导入后：和上次之间没有重叠
export type ImportGap = { dateFrom: string; previousDateTo: string };

function maxDate(dates: readonly string[]): string | null {
  let max: string | null = null;
  for (const d of dates) if (max === null || d > max) max = d;
  return max;
}

// R12.2 导入前：today 由调用方给（todayInMelbourne()）
export function importCoverage(batches: readonly CoverageBatch[], today: string): ImportCoverage {
  const lastDateTo = maxDate(batches.map((b) => b.dateTo));
  const statementDateTo = maxDate(batches.filter((b) => b.source === 'pdf').map((b) => b.dateTo));
  return {
    lastDateTo,
    suggestedFrom: lastDateTo === null ? null : addDays(lastDateTo, -7),
    suggestedTo: lastDateTo === null ? null : today,
    statementDateTo,
  };
}

// R12.2 导入后，只对 CSV 批次：本次 date_from > 上次的 X → 中间可能漏了。只提醒，不拦导入
export function csvGapWarning(dateFrom: string, lastDateTo: string | null): ImportGap | null {
  if (lastDateTo === null || dateFrom <= lastDateTo) return null;
  return { dateFrom, previousDateTo: lastDateTo };
}
