// M6.7-6 小票数据层（business-rules.md R20）
// 期望值来自 business-rules.md R20.4、R20.5、R20.7、R20.8 和 fixtures/README.md "小票用例"
// 假 reader 直接返回 fixtures/receipts 的 JSON，不碰网络
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { rawReceiptSchema } from '@/lib/rules/receipt';
import { importCsv } from '@/server/imports';
import type { ReceiptInput, ReceiptReader } from '@/server/receipt-readers';
import { getReceiptCandidates, scanReceipt } from '@/server/receipts';
import { readFixture, readReceiptFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  TEST_USER,
  type DbTestHousehold,
} from './helpers/db';
import { listTransactions } from './helpers/transactions';

let t: DbTestHousehold;

const IMAGE: ReceiptInput = {
  kind: 'image',
  image: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }),
};
const FAKE_READER_ID = 'llm:fake/model-1';

// 假 reader：返回 fixture 的原始结果，记下收到的分类列表
function fakeReader(name: `${string}.json`) {
  const calls: string[][] = [];
  const reader: ReceiptReader = {
    id: 'llm',
    input: 'image',
    async read(_input, categories) {
      calls.push(categories);
      return {
        ok: true,
        raw: rawReceiptSchema.parse(readReceiptFixture(name)),
        reader: FAKE_READER_ID,
      };
    },
  };
  return { reader, calls };
}

const failingReader: ReceiptReader = {
  id: 'llm',
  input: 'image',
  read: async () => ({ ok: false, reason: 'HTTP 429' }),
};

async function importFixture(target: DbTestHousehold, account: string, path: FixturePath) {
  const result = await importCsv(target.ctx, {
    accountId: target.h.account(account).id,
    fileName: path,
    text: readFixture(path),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result;
}

// joint #19：2026-09-01 -58.40 COLES 0559 MELBOURNE，卡 1111
async function joint19(target: DbTestHousehold = t) {
  const rows = (await listTransactions(target, 'ANZ Joint')).filter(
    (r) => r.date === '2026-09-01' && r.amountCents === -5840,
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

// 第 3 步有 saveReceipt 之前，直接写一行 receipt
async function insertReceipt(
  target: DbTestHousehold,
  r: { merchant: string; date: string; totalCents: number; transactionId?: string | null },
) {
  await db.insert(schema.receipt).values({
    householdId: target.ctx.householdId,
    transactionId: r.transactionId ?? null,
    merchant: r.merchant,
    receiptDate: r.date,
    totalCents: r.totalCents,
    parsedJson: { items: [], discounts: [], payment: 'card' },
    reader: 'manual',
    createdBy: TEST_USER.id,
  });
}

describeDb('scanReceipt（R20.1、R20.2、R20.4、R20.5）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R-A: coles-a after importing joint → normalized, check passes, only candidate #19 selected by default', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const { reader } = fakeReader('coles-a.json');

    const draft = await scanReceipt(t.ctx, IMAGE, reader);

    expect(draft.read).toEqual({ status: 'ok' });
    expect(draft.reader).toBe(FAKE_READER_ID);
    expect(draft.check).toEqual({ ok: true });
    expect(draft.receipt).toMatchObject({
      merchant: 'COLES',
      date: '2026-08-31',
      totalCents: 5840,
      payment: { method: 'card', cardLast4: '1111' },
    });
    expect(draft.receipt.items).toHaveLength(9);
    expect(draft.receipt.items[3]).toMatchObject({ amountCents: -80, categoryId: null });
    expect(draft.receipt.items[4].categoryId).toBe(
      t.h.category('Home & utilities / Household supplies').id,
    );
    expect(draft.candidates).toMatchObject({
      defaultId: n19.id,
      possibleDuplicate: false,
      candidates: [{ id: n19.id, accountName: 'ANZ Joint', cardLast4: '1111' }],
    });
    expect(draft.candidates!.candidates).toHaveLength(1);
  });

  it('R20.1a: the reader gets only selectable expense second-level categories as `一级 / 二级`', async () => {
    const { reader, calls } = fakeReader('coles-a.json');
    const draft = await scanReceipt(t.ctx, IMAGE, reader);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(draft.categories.map((c) => c.label));
    expect(calls[0]).toContain('Home & utilities / Household supplies');
    expect(calls[0]).toContain('Groceries / Supermarket');
    // 收入、系统分类、一级都不在里面
    for (const c of t.h.categories.filter((c) => c.kind !== 'expense' || c.parentId === null)) {
      expect(draft.categories.map((x) => x.id)).not.toContain(c.id);
    }
  });

  it('R-E: coles-e on an empty database → no candidates; card 2222 → default account ANZ Joint', async () => {
    const { reader } = fakeReader('coles-e.json');
    const draft = await scanReceipt(t.ctx, IMAGE, reader);

    expect(draft.check).toEqual({ ok: true });
    expect(draft.candidates).toEqual({ candidates: [], defaultId: null, possibleDuplicate: false });
    expect(draft.account).toEqual({
      accountId: t.h.account('ANZ Joint').id,
      cardAccountIds: [t.h.account('ANZ Joint').id],
    });
  });

  it('R20.1: RECEIPT_READER = none (reader null) → empty draft, reader manual, no candidates', async () => {
    const draft = await scanReceipt(t.ctx, IMAGE, null);
    expect(draft.read).toEqual({ status: 'none' });
    expect(draft.reader).toBe('manual');
    expect(draft.receipt).toEqual({
      merchant: '',
      date: null,
      totalCents: null,
      items: [],
      discounts: [],
      payment: { method: 'unknown', cardLast4: null },
    });
    expect(draft.check.ok).toBe(false);
    expect(draft.candidates).toBeNull();
    expect(draft.categories.length).toBeGreaterThan(0);
  });

  it('R20: reader fails → empty draft with the reason, reader manual', async () => {
    const draft = await scanReceipt(t.ctx, IMAGE, failingReader);
    expect(draft.read).toEqual({ status: 'failed', reason: 'HTTP 429' });
    expect(draft.reader).toBe('manual');
    expect(draft.receipt.items).toEqual([]);
    expect(draft.candidates).toBeNull();
  });

  it('R20: a reader that throws anyway → failed, not a throw', async () => {
    const throwing: ReceiptReader = {
      ...failingReader,
      read: () => Promise.reject(new Error('boom')),
    };
    const draft = await scanReceipt(t.ctx, IMAGE, throwing);
    expect(draft.read).toEqual({ status: 'failed', reason: '识别出错' });
  });

  it('R20.4: #19 already has a receipt → not a candidate', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    await insertReceipt(t, {
      merchant: 'OTHER SHOP',
      date: '2026-09-01',
      totalCents: 5840,
      transactionId: n19.id,
    });

    const draft = await scanReceipt(t.ctx, IMAGE, fakeReader('coles-a.json').reader);
    expect(draft.candidates).toEqual({ candidates: [], defaultId: null, possibleDuplicate: false });
  });

  it('R20.7: same cleaned merchant, date and total → possibleDuplicate, attached or not; other total → no', async () => {
    await insertReceipt(t, { merchant: ' coles ', date: '2026-08-31', totalCents: 5840 });
    const draft = await scanReceipt(t.ctx, IMAGE, fakeReader('coles-a.json').reader);
    expect(draft.candidates!.possibleDuplicate).toBe(true);

    expect(
      (
        await getReceiptCandidates(
          t.ctx,
          { merchant: 'COLES', date: '2026-08-31', totalCents: 5841 },
          '1111',
        )
      ).possibleDuplicate,
    ).toBe(false);
  });
});

describeDb('getReceiptCandidates（R20.4）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R20.4: date or total still missing → no candidates', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const empty = { candidates: [], defaultId: null, possibleDuplicate: false };
    expect(
      await getReceiptCandidates(
        t.ctx,
        { merchant: 'COLES', date: null, totalCents: 5840 },
        '1111',
      ),
    ).toEqual(empty);
    expect(
      await getReceiptCandidates(
        t.ctx,
        { merchant: 'COLES', date: '2026-08-31', totalCents: null },
        null,
      ),
    ).toEqual(empty);
  });

  it('R20.4: user corrected the date in the review form → #19 found again', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const r = await getReceiptCandidates(
      t.ctx,
      { merchant: 'COLES', date: '2026-08-29', totalCents: 5840 },
      '1111',
    );
    // 09-01 − 08-29 = 3 天，还在范围里
    expect(r.candidates.map((c) => c.id)).toEqual([n19.id]);
    expect(
      (
        await getReceiptCandidates(
          t.ctx,
          { merchant: 'COLES', date: '2026-08-28', totalCents: 5840 },
          '1111',
        )
      ).candidates,
    ).toEqual([]);
  });

  it("R20.4: another household's transaction and receipt are invisible", async () => {
    // household_user.user_id 唯一：先把 t 的关联删掉，才能给同一个测试用户再建一个家庭
    await db.delete(schema.householdUser).where(eq(schema.householdUser.userId, TEST_USER.id));
    const other = await createTestHousehold();
    await importFixture(other, 'ANZ Joint', 'anz/joint-2026-09.csv');
    await insertReceipt(other, { merchant: 'COLES', date: '2026-08-31', totalCents: 5840 });

    const draft = await scanReceipt(t.ctx, IMAGE, fakeReader('coles-a.json').reader);
    expect(draft.candidates).toEqual({ candidates: [], defaultId: null, possibleDuplicate: false });
  });
});
