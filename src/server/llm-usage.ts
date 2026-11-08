// R26.9 LLM 调用次数的数据访问（M12-3）：只用来数限额，不存图片、请求、返回内容
// 能不能识别、显示什么用 src/lib/rules/llm-quota.ts 的纯函数
import { and, between, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { llmUsage } from '@/db/schema';
import { endOfMonth } from '@/lib/rules/periods';
import type { HouseholdContext } from './context';

export type LlmUsagePurpose = (typeof llmUsage.purpose.enumValues)[number];

// month = 'YYYY-MM'。created_at 换成 Melbourne 时间以后落在这个月的条数，家里所有人一起算
export async function countLlmUsage(
  ctx: HouseholdContext,
  purpose: LlmUsagePurpose,
  month: string,
): Promise<number> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`月份格式不对: ${month}`);
  const start = `${month}-01`;
  const end = endOfMonth(start);
  return db.$count(
    llmUsage,
    and(
      eq(llmUsage.householdId, ctx.householdId),
      eq(llmUsage.purpose, purpose),
      between(sql`(${llmUsage.createdAt} at time zone 'Australia/Melbourne')::date`, start, end),
    ),
  );
}

// 调用 LLM 之前写入，不管之后成功失败都算一次
export async function recordLlmUsage(
  ctx: HouseholdContext,
  purpose: LlmUsagePurpose,
): Promise<void> {
  await db
    .insert(llmUsage)
    .values({ householdId: ctx.householdId, userId: ctx.userId, purpose, createdAt: new Date() });
}
