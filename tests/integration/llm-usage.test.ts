// M12-3 LLM 调用次数的数据层（docs/rules/R26-invite.md R26.9）
// 期望值来自 fixtures/cases/17-invite.md 场景 G-1、G-5、G-6（家庭一起算的部分）
// 识别按钮、服务端挡下来（G-3、G-4、G-6 其他几条）在 M12-7 测
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { HouseholdContext } from '@/server/context';
import { countLlmUsage, recordLlmUsage } from '@/server/llm-usage';
import { createTestHousehold, describeDb, resetBusinessTables } from './helpers/db';

const NOW = new Date('2026-12-10T10:00:00+11:00');
const MINUTE = 60 * 1000;

const OTHER_USER = { id: 'u-other', email: 'olivia@example.com', name: 'Olivia' };

let h1: HouseholdContext;
let h2: HouseholdContext;
let h3: HouseholdContext;

// n 条，从 start 开始每条加 1 分钟
const rows = (ctx: HouseholdContext, start: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    householdId: ctx.householdId,
    userId: ctx.userId,
    purpose: 'receipt' as const,
    createdAt: new Date(new Date(start).getTime() + i * MINUTE),
  }));

async function newHousehold(name: string): Promise<HouseholdContext> {
  const [hh] = await db
    .insert(schema.household)
    .values({ name })
    .returning({ id: schema.household.id });
  return { userId: OTHER_USER.id, householdId: hh.id, memberId: null };
}

describeDb('LLM 调用次数（R26.9）', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await resetBusinessTables();
    await db
      .insert(schema.user)
      .values({ ...OTHER_USER, emailVerified: true })
      .onConflictDoNothing({ target: schema.user.id });

    h1 = (await createTestHousehold()).ctx;
    h2 = await newHousehold('别人家');
    h3 = await newHousehold('Alex Chen的家');

    await db.insert(schema.llmUsage).values([
      // H1 11 月 50 条，最后一条 2026-11-30 23:59（Melbourne）
      ...rows(h1, '2026-11-10T00:00:00Z', 49),
      ...rows(h1, '2026-11-30T12:59:00Z', 1),
      // H1 12 月 49 条，第一条 2026-12-01 00:00（Melbourne），UTC 还是 11 月 30 日
      ...rows(h1, '2026-11-30T13:00:00Z', 1),
      ...rows(h1, '2026-12-05T00:00:00Z', 48),
      // H2 12 月 50 条
      ...rows(h2, '2026-12-03T00:00:00Z', 50),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('R26.9: counts by Melbourne calendar month, not UTC', async () => {
    expect(await countLlmUsage(h1, 'receipt', '2026-12')).toBe(49);
    expect(await countLlmUsage(h1, 'receipt', '2026-11')).toBe(50);
  });

  it('R26.9: households are counted separately', async () => {
    expect(await countLlmUsage(h2, 'receipt', '2026-12')).toBe(50);
    expect(await countLlmUsage(h3, 'receipt', '2026-12')).toBe(0);
  });

  it('R26.9: record writes one row for the household, all users share the count', async () => {
    await recordLlmUsage(h1, 'receipt');
    await recordLlmUsage({ ...h1, userId: OTHER_USER.id }, 'receipt');
    expect(await countLlmUsage(h1, 'receipt', '2026-12')).toBe(51);
    expect(await countLlmUsage(h2, 'receipt', '2026-12')).toBe(50);

    const [last] = await db
      .select()
      .from(schema.llmUsage)
      .where(
        and(
          eq(schema.llmUsage.householdId, h1.householdId),
          eq(schema.llmUsage.userId, OTHER_USER.id),
        ),
      );
    expect(last).toMatchObject({ householdId: h1.householdId, purpose: 'receipt', createdAt: NOW });
  });
});
