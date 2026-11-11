// M12-7 小票识别限额（docs/rules/R26-invite.md R26.9）
// 期望值来自 fixtures/cases/17-invite.md 场景 G-3、G-4、G-5、G-6
// 假 reader 直接返回 fixtures/receipts 的 JSON，不碰网络
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { rawReceiptSchema } from '@/lib/rules/receipt';
import type { HouseholdContext } from '@/server/context';
import { getReceiptReader, type ReceiptInput, type ReceiptReader } from '@/server/receipt-readers';
import { getReceiptQuota, scanReceipt } from '@/server/receipts';
import { readReceiptFixture } from '../helpers/fixtures';
import { createTestHousehold, describeDb, resetBusinessTables } from './helpers/db';

const NOW = new Date('2026-12-10T10:00:00+11:00'); // 基础值
const MINUTE = 60 * 1000;

const IMAGE: ReceiptInput = {
  kind: 'image',
  image: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }),
};

let h1: HouseholdContext;
let h2: HouseholdContext;

// n 条，从 start 开始每条加 1 分钟
const rows = (ctx: HouseholdContext, start: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    householdId: ctx.householdId,
    userId: ctx.userId,
    purpose: 'receipt' as const,
    createdAt: new Date(new Date(start).getTime() + i * MINUTE),
  }));

// 会真的调 LLM 的假 reader，记下被调了几次
function meteredReader(result: 'ok' | 'fail' | 'throw' = 'ok') {
  const calls = { n: 0 };
  const reader: ReceiptReader = {
    id: 'llm',
    input: 'image',
    metered: true,
    async read() {
      calls.n++;
      if (result === 'throw') throw new Error('boom');
      if (result === 'fail') return { ok: false, reason: 'HTTP 500' };
      return {
        ok: true,
        raw: rawReceiptSchema.parse(readReceiptFixture('coles-a.json')),
        reader: 'llm:fake/model-1',
      };
    },
  };
  return { reader, calls };
}

async function count(ctx: HouseholdContext): Promise<number> {
  return db.$count(schema.llmUsage, eq(schema.llmUsage.householdId, ctx.householdId));
}

async function countDec(ctx: HouseholdContext): Promise<number> {
  const all = await db
    .select({ createdAt: schema.llmUsage.createdAt })
    .from(schema.llmUsage)
    .where(eq(schema.llmUsage.householdId, ctx.householdId));
  // 12 月（Melbourne）= UTC 2026-11-30T13:00 以后
  return all.filter((r) => r.createdAt >= new Date('2026-11-30T13:00:00Z')).length;
}

describeDb('小票识别限额（R26.9）', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubEnv('RECEIPT_LLM_MONTHLY_LIMIT', ''); // 用默认 50
    await resetBusinessTables();

    h1 = (await createTestHousehold()).ctx;
    const [hh] = await db
      .insert(schema.household)
      .values({ name: '别人家' })
      .returning({ id: schema.household.id });
    h2 = { userId: h1.userId, householdId: hh.id, memberId: null };

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
    vi.unstubAllEnvs();
  });

  it('R26.9 G-3: 49 used → can read once, then used up and the server blocks without calling the LLM', async () => {
    const { reader, calls } = meteredReader();
    expect(await getReceiptQuota(h1, reader)).toEqual({
      canRead: true,
      text: '本月还能识别 1 次',
    });

    const first = await scanReceipt(h1, IMAGE, reader);
    expect(first.read).toEqual({ status: 'ok' });
    expect(calls.n).toBe(1);
    expect(await countDec(h1)).toBe(50);

    expect(await getReceiptQuota(h1, reader)).toEqual({
      canRead: false,
      text: '本月识别次数用完了，1 月 1 日恢复',
    });

    // 绕过按钮直接调
    const second = await scanReceipt(h1, IMAGE, reader);
    expect(second.read).toEqual({ status: 'quota', message: '本月识别次数用完了，1 月 1 日恢复' });
    expect(second.reader).toBe('manual');
    expect(second.receipt.items).toEqual([]);
    expect(calls.n).toBe(1);
    expect(await countDec(h1)).toBe(50);
  });

  it('R26.9 G-4: 11-30 23:59:30 is still November (used up), 12-01 00:00 resets', async () => {
    const { reader, calls } = meteredReader();

    vi.setSystemTime(new Date('2026-11-30T23:59:30+11:00'));
    expect(await getReceiptQuota(h1, reader)).toEqual({
      canRead: false,
      text: '本月识别次数用完了，12 月 1 日恢复',
    });
    const blocked = await scanReceipt(h1, IMAGE, reader);
    expect(blocked.read.status).toBe('quota');
    expect(calls.n).toBe(0);

    vi.setSystemTime(new Date('2026-12-01T00:00:00+11:00'));
    expect(await getReceiptQuota(h1, reader)).toEqual({
      canRead: true,
      text: '本月还能识别 49 次',
    });
  });

  it('R26.9 G-5: households do not affect each other', async () => {
    const { reader } = meteredReader();
    expect((await getReceiptQuota(h2, reader))?.canRead).toBe(false);
    expect((await getReceiptQuota(h1, reader))?.canRead).toBe(true);

    await scanReceipt(h1, IMAGE, reader);
    expect(await countDec(h1)).toBe(50);
    expect(await count(h2)).toBe(50);
  });

  it.each([['fail' as const], ['throw' as const]])(
    'R26.9 G-6: LLM %s still counts once',
    async (result) => {
      const { reader, calls } = meteredReader(result);
      const draft = await scanReceipt(h1, IMAGE, reader);
      expect(draft.read.status).toBe('failed');
      expect(calls.n).toBe(1);
      expect(await countDec(h1)).toBe(50);
    },
  );

  it('R26.9 G-6: RECEIPT_READER=llm without LLM_API_KEY sends nothing and does not count', async () => {
    const reader = getReceiptReader({ RECEIPT_READER: 'llm' });
    const draft = await scanReceipt(h1, IMAGE, reader);
    expect(draft.read.status).toBe('failed');
    expect(await countDec(h1)).toBe(49);
    // 次数照样显示
    expect(await getReceiptQuota(h1, reader)).toEqual({
      canRead: true,
      text: '本月还能识别 1 次',
    });
  });

  it('R26.9 G-6: RECEIPT_READER=none does not count and shows no quota', async () => {
    const draft = await scanReceipt(h1, IMAGE, null);
    expect(draft.read).toEqual({ status: 'none' });
    expect(await countDec(h1)).toBe(49);
    expect(await getReceiptQuota(h1, null)).toBeNull();
  });

  it('R26.9 G-6: used up does not stop manual fill (reader null still opens an empty draft)', async () => {
    await db.insert(schema.llmUsage).values(rows(h1, '2026-12-09T00:00:00Z', 1));
    const draft = await scanReceipt(h1, IMAGE, null);
    expect(draft.read).toEqual({ status: 'none' });
    expect(draft.categories.length).toBeGreaterThan(0);
    expect(await countDec(h1)).toBe(50);
  });
});
