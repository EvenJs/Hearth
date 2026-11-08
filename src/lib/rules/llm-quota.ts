// 小票识别限额（docs/rules/R26-invite.md R26.9）
// 本月用了几次由数据层按 Melbourne 自然月数好传进来，"今天"也由调用方传
// 纯函数，不 import 数据库和 Next.js

import { addDays, endOfMonth } from './periods';

export const DEFAULT_RECEIPT_LLM_MONTHLY_LIMIT = 50;

// R26.9 没填、不是正整数都当 50
export function parseMonthlyLimit(env: string | undefined): number {
  const value = (env ?? '').trim();
  if (!/^\d+$/.test(value)) return DEFAULT_RECEIPT_LLM_MONTHLY_LIMIT;
  const limit = Number(value);
  return limit > 0 ? limit : DEFAULT_RECEIPT_LLM_MONTHLY_LIMIT;
}

// R26.9 不显示负数
export function quotaLeft(usedThisMonth: number, limit: number): number {
  return Math.max(0, limit - usedThisMonth);
}

// R26.9 下个月 1 日（Melbourne）重置
export function quotaResetDate(today: string): string {
  return addDays(endOfMonth(today), 1);
}

// R26.9 小票页上的提示
export function quotaText(usedThisMonth: number, limit: number, today: string): string {
  const left = quotaLeft(usedThisMonth, limit);
  if (left > 0) return `本月还能识别 ${left} 次`;
  const month = Number(quotaResetDate(today).slice(5, 7));
  return `本月识别次数用完了，${month} 月 1 日恢复`;
}
