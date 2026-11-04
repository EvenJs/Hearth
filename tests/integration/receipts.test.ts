// M6.7-6 小票数据层（business-rules.md R20）
// 期望值来自 business-rules.md R20.4、R20.5、R20.7、R20.8 和 fixtures/README.md "小票用例"
// 假 reader 直接返回 fixtures/receipts 的 JSON，不碰网络
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { rawReceiptSchema } from '@/lib/rules/receipt';
import { getUndoPreview, importCsv, undoImport } from '@/server/imports';
import { deleteManualTransaction, updateManualTransaction } from '@/server/manual';
import type { ReceiptInput, ReceiptReader } from '@/server/receipt-readers';
import {
  attachReceipt,
  deleteReceipt,
  getReceiptAttachOptions,
  getReceiptCandidates,
  getTransactionReceipt,
  listUnattachedReceipts,
  previewAttachReceipt,
  previewReceipt,
  saveReceipt,
  scanReceipt,
  setReceiptItemType,
  type SaveReceiptInput,
} from '@/server/receipts';
import { addSplit, setSplitOneOff, updateSplit } from '@/server/splits';
import { readFixture, readReceiptFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  TEST_USER,
  type DbTestHousehold,
} from './helpers/db';
import { getSplits, getTransaction, insertPending, listTransactions } from './helpers/transactions';

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

// ==================== 保存、挂上、删除（R20.3 到 R20.7） ====================

// 核对后的小票：和 reader 原始结果一样的字符串格式，这里直接用 fixture
const raw = (name: `${string}.json`) => readReceiptFixture(name) as SaveReceiptInput['receipt'];

async function save(input: Partial<SaveReceiptInput> & Pick<SaveReceiptInput, 'target'>) {
  return saveReceipt(t.ctx, { reader: FAKE_READER_ID, receipt: raw('coles-a.json'), ...input });
}

async function saveOk(input: Partial<SaveReceiptInput> & Pick<SaveReceiptInput, 'target'>) {
  const r = await save(input);
  if (!r.ok) throw new Error(`保存失败: ${r.code} ${r.message}`);
  return r;
}

async function receiptRows() {
  return db.select().from(schema.receipt).orderBy(schema.receipt.createdAt);
}

// 拆分的样子：金额、分类、归属人（来源）、category_source、备注
async function splitShape(transactionId: string, target: DbTestHousehold = t) {
  const name = (id: string) => target.h.categories.find((c) => c.id === id)!;
  const member = (id: string) => target.h.members.find((m) => m.id === id)!.name;
  return (await getSplits(transactionId)).map((x) => ({
    primary: x.isPrimary,
    amountCents: x.amountCents,
    category: name(x.categoryId).id === x.categoryId ? path(target, x.categoryId) : '?',
    member: `${member(x.memberId)} (${x.memberSource})`,
    categorySource: x.categorySource,
    note: x.note,
  }));
}

function path(target: DbTestHousehold, id: string): string {
  const c = target.h.categories.find((x) => x.id === id)!;
  const parent = c.parentId ? target.h.categories.find((x) => x.id === c.parentId)! : null;
  return parent ? `${parent.nameEn} / ${c.nameEn}` : c.nameEn;
}

// R-A 的结果（R20.8）
const R_A_SPLITS = [
  {
    primary: true,
    amountCents: -3140,
    category: 'Groceries / Supermarket',
    member: 'Home (category)',
    categorySource: 'rule',
    note: null,
  },
  {
    primary: false,
    amountCents: -1500,
    category: 'Home & utilities / Household supplies',
    member: 'Home (category)',
    categorySource: 'manual',
    note: null,
  },
  {
    primary: false,
    amountCents: -1200,
    category: 'Personal & medical / Cosmetics & toiletries',
    member: 'Male (card)',
    categorySource: 'manual',
    note: null,
  },
];

describeDb('saveReceipt（R20.3、R20.4、R20.6、R20.7）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R-A: coles-a on #19 → three splits as in R20.8, receipt stored with the fake reader id', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();

    const r = await saveOk({ target: { kind: 'transaction', transactionId: n19.id } });

    expect(r.transactionId).toBe(n19.id);
    expect(await splitShape(n19.id)).toEqual(R_A_SPLITS);
    const [row] = await receiptRows();
    expect(row).toMatchObject({
      id: r.receiptId,
      transactionId: n19.id,
      merchant: 'COLES',
      receiptDate: '2026-08-31',
      totalCents: 5840,
      reader: FAKE_READER_ID,
      createdBy: TEST_USER.id,
    });
    expect(row.parsedJson).toEqual({
      items: expect.arrayContaining([
        // R21.8：没传类型 → 自动给的（T-2）
        { name: 'KIWIFRUIT 4 FOR $6', amountCents: -80, category: null, type: 'fruit' },
        {
          name: 'SHAMPOO 400ML',
          amountCents: 1200,
          category: t.h.category('Personal & medical / Cosmetics & toiletries').id,
          type: 'household',
        },
      ]),
      discounts: [],
      payment: 'card',
    });
    // 交易本身不变（挂到已有交易上的小票不改 source）
    expect((await getTransaction(n19.id)).source).toBe('csv');
  });

  it("R-A': coles-a again after R-A → possibly uploaded already; #19 is no longer a candidate", async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    await saveOk({ target: { kind: 'transaction', transactionId: (await joint19()).id } });

    const draft = await scanReceipt(t.ctx, IMAGE, fakeReader('coles-a.json').reader);
    expect(draft.candidates).toEqual({ candidates: [], defaultId: null, possibleDuplicate: true });
  });

  it('R20.1: filled in by hand (reader none or failed) → reader manual', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    await saveOk({
      reader: 'manual',
      target: { kind: 'transaction', transactionId: (await joint19()).id },
    });
    expect((await receiptRows())[0].reader).toBe('manual');
  });

  it('R-E: coles-e, no match → new ANZ Joint pending (source receipt); importing the bank row confirms it and keeps the receipt', async () => {
    const r = await saveOk({
      receipt: raw('coles-e.json'),
      target: { kind: 'new', accountId: t.h.account('ANZ Joint').id },
    });

    const tx = await getTransaction(r.transactionId);
    expect(tx).toMatchObject({
      accountId: t.h.account('ANZ Joint').id,
      status: 'pending',
      source: 'receipt',
      date: '2026-09-28',
      amountCents: -2345,
      cardLast4: null,
      merchant: 'COLES',
      importBatchId: null,
    });
    expect(await splitShape(r.transactionId)).toEqual([
      {
        primary: true,
        amountCents: -2345,
        category: 'Groceries / Supermarket',
        member: 'Home (category)',
        categorySource: 'rule',
        note: null,
      },
    ]);

    const imported = await importCsv(t.ctx, {
      accountId: t.h.account('ANZ Joint').id,
      fileName: 'coles-e.csv',
      text: '29/09/2026,"-23.45",VISA DEBIT PURCHASE CARD 2222 COLES 0559 MELBOURNE\n',
    });
    if (!imported.ok) throw new Error(imported.message);

    const after = await getTransaction(r.transactionId);
    expect(after).toMatchObject({ status: 'confirmed', source: 'receipt', cardLast4: '2222' });
    expect(after.importBatchId).toBe(imported.batchId);
    expect(await db.$count(schema.transaction)).toBe(1);
    expect((await receiptRows())[0].transactionId).toBe(r.transactionId);
  });

  it('R17.5 + R20.7: the receipt-created pending can be edited and deleted like manual; deleting detaches the receipt', async () => {
    const r = await saveOk({
      receipt: raw('coles-e.json'),
      target: { kind: 'new', accountId: t.h.account('ANZ Joint').id },
    });
    const edited = await updateManualTransaction(
      t.ctx,
      r.transactionId,
      { description: 'COLES CENTRAL' },
      '2026-10-29',
    );
    expect(edited).toEqual({ ok: true, changed: true });

    expect(await deleteManualTransaction(t.ctx, r.transactionId)).toEqual({ ok: true });
    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].transactionId).toBeNull();
  });

  it('R20.6: #19 already split, no confirm → needs_confirm and nothing changes; with confirm → old extra split gone, primary note kept', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const added = await addSplit(t.ctx, n19.id, {
      amountCents: 800,
      categoryId: t.h.category('Personal & medical / Cosmetics & toiletries').id,
    });
    if (!added.ok) throw new Error(added.message);
    const primary = (await getSplits(n19.id)).find((x) => x.isPrimary)!;
    expect((await updateSplit(t.ctx, primary.id, { note: '周末采购' })).ok).toBe(true);
    const before = await getSplits(n19.id);

    const refused = await save({ target: { kind: 'transaction', transactionId: n19.id } });
    expect(refused).toMatchObject({
      ok: false,
      code: 'needs_confirm',
      splitCount: 2,
      manualCategory: false,
    });
    expect(await getSplits(n19.id)).toEqual(before);
    expect(await db.$count(schema.receipt)).toBe(0);

    await saveOk({
      target: { kind: 'transaction', transactionId: n19.id },
      confirmOverwrite: true,
    });
    const after = await getSplits(n19.id);
    expect(after.map((x) => x.id)).not.toContain(added.splitId);
    expect(after.find((x) => x.isPrimary)).toMatchObject({ id: primary.id, note: '周末采购' });
    expect(await splitShape(n19.id)).toEqual([
      { ...R_A_SPLITS[0], note: '周末采购' },
      R_A_SPLITS[1],
      R_A_SPLITS[2],
    ]);
  });

  it('R20.6: primary with a manual category also needs confirm', async () => {
    const id = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-08-31',
      amountCents: -5840,
      category: 'Groceries / Supermarket',
      member: 'Home',
    });
    expect(await save({ target: { kind: 'transaction', transactionId: id } })).toMatchObject({
      ok: false,
      code: 'needs_confirm',
      splitCount: 1,
      manualCategory: true,
    });
  });

  it('R-C: coles-a on a -50.00 transaction → split_failed "小票合计比这笔交易多 $8.40", nothing written', async () => {
    const id = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-08-31',
      amountCents: -5000,
      category: 'Groceries / Supermarket',
      member: 'Home',
    });
    const before = await getSplits(id);
    const r = await save({
      target: { kind: 'transaction', transactionId: id },
      confirmOverwrite: true,
    });
    expect(r).toEqual({
      ok: false,
      code: 'split_failed',
      message: '小票合计比这笔交易多 $8.40，不支持',
    });
    expect(await getSplits(id)).toEqual(before);
    expect(await db.$count(schema.receipt)).toBe(0);
  });

  it('R-D: bad-total → check_failed with the difference, nothing written', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const r = await save({
      receipt: raw('bad-total.json'),
      target: { kind: 'transaction', transactionId: (await joint19()).id },
    });
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
    if (r.ok || r.code !== 'check_failed') return;
    expect(r.issues).toContainEqual(
      expect.objectContaining({ code: 'sum_mismatch', diffCents: 100 }),
    );
    expect(await db.$count(schema.receipt)).toBe(0);
  });

  it('R20.7: a transaction that already has a receipt → has_receipt', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const target = { kind: 'transaction', transactionId: (await joint19()).id } as const;
    await saveOk({ target });
    expect(await save({ target, confirmOverwrite: true })).toMatchObject({
      ok: false,
      code: 'has_receipt',
    });
    expect(await db.$count(schema.receipt)).toBe(1);
  });

  it('R15.2 + R20.4: internal transfer → refused, nothing written', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    // #11 TRANSFER TO ****0003 -500.00，auto
    const n11 = (await listTransactions(t, 'ANZ Joint')).find((x) => x.amountCents === -50000)!;
    expect(n11.transferStatus).toBe('auto');
    const r = await save({ target: { kind: 'transaction', transactionId: n11.id } });
    expect(r).toMatchObject({ ok: false, code: 'transfer' });
    expect(await db.$count(schema.receipt)).toBe(0);
  });

  it('R20.5: new transaction on an archived account → account error, nothing written', async () => {
    await db
      .update(schema.financialAccount)
      .set({ isArchived: true })
      .where(eq(schema.financialAccount.id, t.h.account('ANZ Joint').id));
    const r = await save({
      receipt: raw('coles-e.json'),
      target: { kind: 'new', accountId: t.h.account('ANZ Joint').id },
    });
    expect(r).toMatchObject({ ok: false, code: 'account' });
    expect(await db.$count(schema.transaction)).toBe(0);
    expect(await db.$count(schema.receipt)).toBe(0);
  });

  it('R20.3: an error halfway through (after the splits are written) rolls back transaction, splits and receipt', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const txBefore = await getTransaction(n19.id);
    const splitsBefore = await getSplits(n19.id);

    // 拆分写完以后，写 receipt 时抛错（同 imports.test.ts R12 的做法）
    const original = db.transaction.bind(db);
    type Tx = Parameters<Parameters<typeof original>[0]>[0];
    vi.spyOn(db, 'transaction').mockImplementation((fn, config) =>
      original((tx) => {
        const failing = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'insert') {
              return (table: Parameters<Tx['insert']>[0]) => {
                if (table === schema.receipt) throw new Error('故意抛错');
                return target.insert(table);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return fn(failing);
      }, config),
    );

    await expect(save({ target: { kind: 'transaction', transactionId: n19.id } })).rejects.toThrow(
      '故意抛错',
    );
    vi.restoreAllMocks();

    expect(await getTransaction(n19.id)).toEqual(txBefore);
    expect(await getSplits(n19.id)).toEqual(splitsBefore);
    expect(await db.$count(schema.receipt)).toBe(0);
  });

  it('R20.7: deleteReceipt only removes the receipt row; splits stay', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const r = await saveOk({ target: { kind: 'transaction', transactionId: n19.id } });

    expect(await deleteReceipt(t.ctx, r.receiptId)).toEqual({ ok: true });
    expect(await db.$count(schema.receipt)).toBe(0);
    expect(await splitShape(n19.id)).toEqual(R_A_SPLITS);
    expect(await deleteReceipt(t.ctx, r.receiptId)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('R22.2: saving clears every one-off flag; oneOffCleared only when one was true', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const [primary] = await getSplits(n19.id);
    expect((await setSplitOneOff(t.ctx, primary.id, true)).ok).toBe(true);

    const r = await saveOk({ target: { kind: 'transaction', transactionId: n19.id } });
    expect(r.oneOffCleared).toBe(true);
    const after = await getSplits(n19.id);
    expect(after).toHaveLength(R_A_SPLITS.length);
    expect(after.every((s) => s.isOneOff === null)).toBe(true);
  });

  it('R22.2: only false flags → cleared too, but oneOffCleared is false', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const [primary] = await getSplits(n19.id);
    expect((await setSplitOneOff(t.ctx, primary.id, false)).ok).toBe(true);

    const r = await saveOk({ target: { kind: 'transaction', transactionId: n19.id } });
    expect(r.oneOffCleared).toBe(false);
    expect((await getSplits(n19.id)).every((s) => s.isOneOff === null)).toBe(true);
  });

  it('R22.2: a new transaction from a receipt has oneOffCleared false and null flags', async () => {
    const r = await saveOk({ target: { kind: 'new', accountId: t.h.account('ANZ Joint').id } });
    expect(r.oneOffCleared).toBe(false);
    expect((await getSplits(r.transactionId)).every((s) => s.isOneOff === null)).toBe(true);
  });
});

describeDb('R-U 撤销导入和重新挂（R12.1、R20.7）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R-U: undo joint after R-A → prompt "挂了小票 1 笔"; receipt detached and listed; re-import joint and re-attach to the new #19', async () => {
    const batch = await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const r = await saveOk({
      target: { kind: 'transaction', transactionId: (await joint19()).id },
    });

    const preview = await getUndoPreview(t.ctx, batch.batchId);
    if (!preview.ok) throw new Error(preview.message);
    expect(preview.prompt).toMatchObject({
      receiptCount: 1,
      manualEditedCount: 1,
      needsConfirm: true,
    });

    const undone = await undoImport(t.ctx, batch.batchId);
    expect(undone.ok).toBe(true);
    const [detached] = await receiptRows();
    expect(detached).toMatchObject({ id: r.receiptId, transactionId: null });
    expect(await listUnattachedReceipts(t.ctx)).toEqual([
      expect.objectContaining({
        id: r.receiptId,
        merchant: 'COLES',
        receiptDate: '2026-08-31',
        totalCents: 5840,
      }),
    ]);

    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const new19 = await joint19();
    expect(new19.id).not.toBe(r.transactionId);
    expect(
      await attachReceipt(t.ctx, r.receiptId, { kind: 'transaction', transactionId: new19.id }),
    ).toEqual({
      ok: true,
      transactionId: new19.id,
      oneOffCleared: false,
      goalCleared: false, // R25.8
    });
    expect(await splitShape(new19.id)).toEqual(R_A_SPLITS);
    expect(await listUnattachedReceipts(t.ctx)).toEqual([]);
    // 已经挂上的不能再挂
    expect(
      await attachReceipt(t.ctx, r.receiptId, {
        kind: 'new',
        accountId: t.h.account('ANZ Joint').id,
      }),
    ).toMatchObject({ ok: false, code: 'attached' });
  });

  it('R20.7: an unattached receipt can also become a new transaction (R20.5)', async () => {
    const batch = await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const r = await saveOk({
      target: { kind: 'transaction', transactionId: (await joint19()).id },
    });
    await undoImport(t.ctx, batch.batchId);

    const attached = await attachReceipt(t.ctx, r.receiptId, {
      kind: 'new',
      accountId: t.h.account('ANZ Joint').id,
    });
    if (!attached.ok) throw new Error(attached.message);
    expect(await getTransaction(attached.transactionId)).toMatchObject({
      source: 'receipt',
      status: 'pending',
      date: '2026-08-31',
      amountCents: -5840,
    });
    // 新建的交易没有卡号，Cosmetics 那组按账户默认（R5），不是 Male (card)
    expect(
      (await splitShape(attached.transactionId)).map((x) => [x.amountCents, x.category]),
    ).toEqual([
      [-3140, 'Groceries / Supermarket'],
      [-1500, 'Home & utilities / Household supplies'],
      [-1200, 'Personal & medical / Cosmetics & toiletries'],
    ]);
  });

  it('R20.1: after R-A, R-E and R-U, no receipt.parsed_json contains card numbers 1111, 2222 or name fields', async () => {
    const batch = await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const a = await saveOk({
      target: { kind: 'transaction', transactionId: (await joint19()).id },
    });
    await saveOk({
      receipt: raw('coles-e.json'),
      target: { kind: 'new', accountId: t.h.account('ANZ Joint').id },
    });
    await undoImport(t.ctx, batch.batchId);
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    await attachReceipt(t.ctx, a.receiptId, {
      kind: 'transaction',
      transactionId: (await joint19()).id,
    });
    // noisy.json 带了 customer、cashier
    await saveOk({
      reader: 'manual',
      receipt: raw('noisy.json'),
      target: { kind: 'new', accountId: t.h.account('ANZ Joint').id },
    });

    const rows = await receiptRows();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const text = JSON.stringify(row.parsedJson);
      expect(text).not.toContain('1111');
      expect(text).not.toContain('2222');
      expect(text).not.toMatch(/cardLast4|customer|cashier/i);
      // R2.3：名字里没有 8 位以上连续数字（分类 id 是 uuid，不在检查范围内）
      const json = row.parsedJson as { items: { name: string }[]; discounts: { label: string }[] };
      for (const text of [
        row.merchant,
        ...json.items.map((i) => i.name),
        ...json.discounts.map((d) => d.label),
      ]) {
        expect(text).not.toMatch(/\d{8,}/);
      }
    }
  });
});

describeDb('另一个家庭（R20、household_id）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it("another household's transactions and receipts: save, attach and delete return not_found; the list does not show them", async () => {
    await db.delete(schema.householdUser).where(eq(schema.householdUser.userId, TEST_USER.id));
    const other = await createTestHousehold();
    await importFixture(other, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const other19 = await joint19(other);
    const otherSaved = await saveReceipt(other.ctx, {
      reader: 'manual',
      receipt: raw('grocer-b.json'),
      target: { kind: 'new', accountId: other.h.account('ANZ Joint').id },
    });
    if (!otherSaved.ok) throw new Error(otherSaved.message);
    // 让 other 的小票变成没挂上
    await db.update(schema.receipt).set({ transactionId: null });
    const before = await splitShape(other19.id, other);

    // 本家庭：挂到别家的交易
    expect(
      await save({ target: { kind: 'transaction', transactionId: other19.id } }),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    // 本家庭：新建在别家的账户上
    expect(
      await save({
        receipt: raw('coles-e.json'),
        target: { kind: 'new', accountId: other.h.account('ANZ Joint').id },
      }),
    ).toMatchObject({ ok: false, code: 'account' });
    // 别家的小票：挂、删、列表
    expect(
      await attachReceipt(t.ctx, otherSaved.receiptId, {
        kind: 'new',
        accountId: t.h.account('ANZ Joint').id,
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(await deleteReceipt(t.ctx, otherSaved.receiptId)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await listUnattachedReceipts(t.ctx)).toEqual([]);

    expect(await splitShape(other19.id, other)).toEqual(before);
    expect(await db.$count(schema.receipt)).toBe(1);
    expect((await listUnattachedReceipts(other.ctx)).map((x) => x.id)).toEqual([
      otherSaved.receiptId,
    ]);
  });
});

describeDb('previewReceipt（核对界面"保存后的拆分"）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R-A: preview on #19 equals what saveReceipt writes, and writes nothing', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const before = await getSplits(n19.id);
    const target = { kind: 'transaction', transactionId: n19.id } as const;

    const p = await previewReceipt(t.ctx, { receipt: raw('coles-a.json'), target });
    expect(p).toMatchObject({
      ok: true,
      transaction: { date: '2026-09-01', amountCents: -5840, accountName: 'ANZ Joint' },
      extraCents: 0,
      overwrite: { needed: false },
    });
    if (!p.ok) return;
    expect(
      p.rows.map((x) => ({
        primary: x.isPrimary,
        amountCents: x.amountCents,
        category: x.categoryLabel,
        member: `${x.memberName} (${x.memberSource})`,
        categorySource: x.categorySource,
        note: null,
      })),
    ).toEqual(R_A_SPLITS);
    expect(await getSplits(n19.id)).toEqual(before);
    expect(await db.$count(schema.receipt)).toBe(0);

    await saveOk({ target });
    expect(await splitShape(n19.id)).toEqual(R_A_SPLITS);
  });

  it('R-C: from the detail page on a -59.28 transaction → preview has -0.88 Uncategorised (system), extraCents 88', async () => {
    const id = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-01',
      amountCents: -5928,
      category: 'Groceries / Supermarket',
      member: 'Home',
    });
    const p = await previewReceipt(t.ctx, {
      receipt: raw('coles-a.json'),
      target: { kind: 'transaction', transactionId: id },
    });
    expect(p).toMatchObject({
      ok: true,
      extraCents: 88,
      overwrite: { needed: true, manualCategory: true },
    });
    if (!p.ok) return;
    expect(p.rows.reduce((sum, x) => sum + x.amountCents, 0)).toBe(-5928);
    expect(p.rows).toContainEqual(
      expect.objectContaining({
        amountCents: -88,
        categoryId: t.h.systemCategory('uncategorized').id,
        categorySource: 'system',
      }),
    );
  });

  it('R-E: preview for a new transaction → one primary Groceries / Supermarket row, nothing created', async () => {
    const p = await previewReceipt(t.ctx, {
      receipt: raw('coles-e.json'),
      target: { kind: 'new', accountId: t.h.account('ANZ Joint').id },
    });
    expect(p).toMatchObject({ ok: true, transaction: null, overwrite: null });
    if (!p.ok) return;
    expect(p.rows).toEqual([
      expect.objectContaining({
        isPrimary: true,
        amountCents: -2345,
        categoryLabel: 'Groceries / Supermarket',
        categorySource: 'rule',
        memberName: 'Home',
      }),
    ]);
    expect(await db.$count(schema.transaction)).toBe(0);
  });

  it('R-C / R-D: failures come back the same as from saveReceipt', async () => {
    const id = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-01',
      amountCents: -5000,
      category: 'Groceries / Supermarket',
      member: 'Home',
    });
    const target = { kind: 'transaction', transactionId: id } as const;
    expect(await previewReceipt(t.ctx, { receipt: raw('coles-a.json'), target })).toEqual({
      ok: false,
      code: 'split_failed',
      message: '小票合计比这笔交易多 $8.40，不支持',
    });
    expect(await previewReceipt(t.ctx, { receipt: raw('bad-total.json'), target })).toMatchObject({
      ok: false,
      code: 'check_failed',
    });
  });
});

describeDb('交易详情的小票、没挂上的小票重新挂（M6.7-8，R20.7）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R20.7: getTransactionReceipt shows the stored items with labels and follow hints; null without a receipt', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    expect(await getTransactionReceipt(t.ctx, n19.id)).toBeNull();
    const r = await saveOk({ target: { kind: 'transaction', transactionId: n19.id } });

    const shown = await getTransactionReceipt(t.ctx, n19.id);
    expect(shown).toMatchObject({
      id: r.receiptId,
      merchant: 'COLES',
      receiptDate: '2026-08-31',
      totalCents: 5840,
      payment: 'card',
      discounts: [],
    });
    expect(shown!.items.map((i) => [i.name, i.amountCents, i.categoryLabel, i.follow])).toEqual([
      ['MILK 3L', 450, null, 'main'],
      ['BANANAS PERKG', 320, null, 'main'],
      ['KIWIFRUIT GOLD', 680, null, 'main'],
      ['KIWIFRUIT 4 FOR $6', -80, null, 'previous'],
      ['PAPER TOWEL 2PK', 600, 'Home & utilities / Household supplies', null],
      ['DISHWASHING LIQUID', 900, 'Home & utilities / Household supplies', null],
      ['SHAMPOO 400ML', 1200, 'Personal & medical / Cosmetics & toiletries', null],
      ['WHITE BREAD', 470, null, 'main'],
      ['TASTY CHEESE', 1300, null, 'main'],
    ]);
    expect(JSON.stringify(shown)).not.toContain('1111');
  });

  it('R20.7: after deleteReceipt the detail has no receipt again and the splits are unchanged', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const r = await saveOk({ target: { kind: 'transaction', transactionId: n19.id } });

    expect(await deleteReceipt(t.ctx, r.receiptId)).toEqual({ ok: true });
    expect(await getTransactionReceipt(t.ctx, n19.id)).toBeNull();
    expect(await splitShape(n19.id)).toEqual(R_A_SPLITS);
  });

  it('R-U: after undo and re-import the attach options list only the new #19 (default); the preview equals what attachReceipt writes and writes nothing', async () => {
    const batch = await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const r = await saveOk({
      target: { kind: 'transaction', transactionId: (await joint19()).id },
    });
    await undoImport(t.ctx, batch.batchId);

    // 还没重新导入：没有候选，新建默认上次账户（R20.5，存的里面没有卡号）
    const before = await getReceiptAttachOptions(t.ctx, r.receiptId);
    if (!before.ok) throw new Error(before.message);
    expect(before.receipt).toEqual({
      id: r.receiptId,
      merchant: 'COLES',
      receiptDate: '2026-08-31',
      totalCents: 5840,
    });
    expect(before.candidates).toEqual([]);
    expect(before.defaultId).toBeNull();
    expect(before.account.cardAccountIds).toEqual([]);

    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const new19 = await joint19();
    const options = await getReceiptAttachOptions(t.ctx, r.receiptId);
    if (!options.ok) throw new Error(options.message);
    expect(options.candidates.map((c) => [c.id, c.accountName])).toEqual([[new19.id, 'ANZ Joint']]);
    expect(options.defaultId).toBe(new19.id);

    const splitsBefore = await getSplits(new19.id);
    const preview = await previewAttachReceipt(t.ctx, r.receiptId, {
      kind: 'transaction',
      transactionId: new19.id,
    });
    if (!preview.ok) throw new Error(preview.message);
    expect(await getSplits(new19.id)).toEqual(splitsBefore);
    expect(preview.extraCents).toBe(0);
    expect(preview.transaction).toMatchObject({ amountCents: -5840, accountName: 'ANZ Joint' });

    expect(
      await attachReceipt(t.ctx, r.receiptId, { kind: 'transaction', transactionId: new19.id }),
    ).toEqual({ ok: true, transactionId: new19.id, oneOffCleared: false, goalCleared: false });
    expect(preview.rows.map((x) => [x.amountCents, x.categoryLabel, x.isPrimary])).toEqual(
      R_A_SPLITS.map((x) => [x.amountCents, x.category, x.primary]),
    );
    expect(await splitShape(new19.id)).toEqual(R_A_SPLITS);
    expect(await listUnattachedReceipts(t.ctx)).toEqual([]);
    expect((await getTransactionReceipt(t.ctx, new19.id))?.id).toBe(r.receiptId);

    // 挂上以后：选项和预览都说已经挂上了
    expect(await getReceiptAttachOptions(t.ctx, r.receiptId)).toMatchObject({
      ok: false,
      code: 'attached',
    });
    expect(
      await previewAttachReceipt(t.ctx, r.receiptId, {
        kind: 'new',
        accountId: t.h.account('ANZ Joint').id,
      }),
    ).toMatchObject({ ok: false, code: 'attached' });
  });

  it("another household's receipt: attach options, preview and detail are not visible", async () => {
    await db.delete(schema.householdUser).where(eq(schema.householdUser.userId, TEST_USER.id));
    const other = await createTestHousehold();
    await importFixture(other, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const other19 = await joint19(other);
    const saved = await saveReceipt(other.ctx, {
      reader: 'manual',
      receipt: raw('coles-a.json'),
      target: { kind: 'transaction', transactionId: other19.id },
    });
    if (!saved.ok) throw new Error(saved.message);

    expect(await getTransactionReceipt(t.ctx, other19.id)).toBeNull();
    await db.update(schema.receipt).set({ transactionId: null });
    expect(await getReceiptAttachOptions(t.ctx, saved.receiptId)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(
      await previewAttachReceipt(t.ctx, saved.receiptId, {
        kind: 'new',
        accountId: t.h.account('ANZ Joint').id,
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
  });
});

// ---------- M7.6-5 商品类型接进保存（R21.4、R21.5、R21.8） ----------
// 期望值来自 R21 和 fixtures/cases/11-item-types.md L-1 ~ L-9、P-1

// 小票 X：CHICKEN STOCK 4.00、BANANA 1KG 3.00，总额 7.00，现金
const X_RAW: SaveReceiptInput['receipt'] = {
  merchant: 'TEST GROCER',
  date: '15/09/2026',
  total: '7.00',
  items: [
    { name: 'CHICKEN STOCK', amount: '4.00', category: null },
    { name: 'BANANA 1KG', amount: '3.00', category: null },
  ],
  discounts: [],
  payment: { method: 'cash', cardLast4: null },
};

function rawReader(r: SaveReceiptInput['receipt']): ReceiptReader {
  return {
    id: 'llm',
    input: 'image',
    read: async () => ({ ok: true, raw: rawReceiptSchema.parse(r), reader: FAKE_READER_ID }),
  };
}

// 扫 X，按用户改过的类型保存成 ANZ Joint 上的新交易
async function saveX(
  target: DbTestHousehold,
  itemTypes: NonNullable<SaveReceiptInput['itemTypes']>,
  receipt: SaveReceiptInput['receipt'] = X_RAW,
) {
  const r = await saveReceipt(target.ctx, {
    reader: FAKE_READER_ID,
    receipt,
    itemTypes,
    target: { kind: 'new', accountId: target.h.account('ANZ Joint').id },
  });
  if (!r.ok) throw new Error(`保存失败: ${r.code} ${r.message}`);
  return r;
}

async function learnedRows() {
  return db
    .select({
      householdId: schema.itemTypeRule.householdId,
      nameKey: schema.itemTypeRule.nameKey,
      itemType: schema.itemTypeRule.itemType,
      updatedAt: schema.itemTypeRule.updatedAt,
    })
    .from(schema.itemTypeRule)
    .orderBy(schema.itemTypeRule.nameKey);
}

async function storedItems(receiptId: string) {
  const [row] = await db.select().from(schema.receipt).where(eq(schema.receipt.id, receiptId));
  return (row.parsedJson as { items: { name: string; type?: string }[] }).items.map((i) => [
    i.name,
    i.type,
  ]);
}

describeDb('商品类型：scanReceipt 和 saveReceipt（R21.4、R21.5、R21.8）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R21.4: scanReceipt gives every item a type with its source (coles-a, T-2)', async () => {
    const draft = await scanReceipt(t.ctx, IMAGE, fakeReader('coles-a.json').reader);
    expect(draft.receipt.items.map((i, n) => [i.name, draft.itemTypes[n]])).toEqual([
      ['MILK 3L', { type: 'dairy_egg', source: 'preset' }],
      ['BANANAS PERKG', { type: 'fruit', source: 'preset' }],
      ['KIWIFRUIT GOLD', { type: 'fruit', source: 'preset' }],
      ['KIWIFRUIT 4 FOR $6', { type: 'fruit', source: 'follow' }],
      ['PAPER TOWEL 2PK', { type: 'household', source: 'preset' }],
      ['DISHWASHING LIQUID', { type: 'household', source: 'preset' }],
      ['SHAMPOO 400ML', { type: 'household', source: 'preset' }],
      ['WHITE BREAD', { type: 'pantry', source: 'preset' }],
      ['TASTY CHEESE', { type: 'dairy_egg', source: 'preset' }],
    ]);
  });

  it('R21.4: reader none → no items, no types', async () => {
    const draft = await scanReceipt(t.ctx, IMAGE, null);
    expect(draft.itemTypes).toEqual([]);
  });

  it('R21.5 L-1 + L-2: change CHICKEN STOCK to pantry → learned; the next `chicken  stock` is pantry (learned)', async () => {
    const draft = await scanReceipt(t.ctx, IMAGE, rawReader(X_RAW));
    expect(draft.itemTypes).toEqual([
      { type: 'meat', source: 'preset' },
      { type: 'fruit', source: 'preset' },
    ]);

    const r = await saveX(t, ['pantry', 'fruit']);
    expect(await storedItems(r.receiptId)).toEqual([
      ['CHICKEN STOCK', 'pantry'],
      ['BANANA 1KG', 'fruit'],
    ]);
    expect(await learnedRows()).toEqual([
      {
        householdId: t.ctx.householdId,
        nameKey: 'CHICKEN STOCK',
        itemType: 'pantry',
        updatedAt: expect.any(Date),
      },
    ]);

    const next = await scanReceipt(
      t.ctx,
      IMAGE,
      rawReader({ ...X_RAW, items: [{ name: 'chicken  stock', amount: '7.00', category: null }] }),
    );
    expect(next.itemTypes).toEqual([{ type: 'pantry', source: 'learned' }]);
  });

  it('R21.5 L-3: after L-1, X saved again unchanged → learning table unchanged', async () => {
    await saveX(t, ['pantry', 'fruit']);
    const before = await learnedRows();

    const draft = await scanReceipt(t.ctx, IMAGE, rawReader(X_RAW));
    await saveX(
      t,
      draft.itemTypes.map((m) => m.type),
    );
    expect(await learnedRows()).toEqual(before);
  });

  it('R21.5 L-4: after L-1, CHICKEN STOCK changed to other → still one row, now other', async () => {
    await saveX(t, ['pantry', 'fruit']);
    await saveX(t, ['other', 'fruit']);
    expect((await learnedRows()).map((r) => [r.nameKey, r.itemType])).toEqual([
      ['CHICKEN STOCK', 'other'],
    ]);
  });

  it('R21.5 L-5: CHICKEN STOCK twice in one receipt, pantry then snack → one row snack', async () => {
    await saveX(t, ['pantry', 'snack'], {
      ...X_RAW,
      items: [
        { name: 'CHICKEN STOCK', amount: '4.00', category: null },
        { name: 'CHICKEN STOCK', amount: '3.00', category: null },
      ],
    });
    expect((await learnedRows()).map((r) => [r.nameKey, r.itemType])).toEqual([
      ['CHICKEN STOCK', 'snack'],
    ]);
  });

  it('R21.4 + R21.5 L-6 + L-7: KIWIFRUIT GOLD → snack, client sends meat for -0.80 → stored snack; only KIWIFRUIT GOLD learned', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const draft = await scanReceipt(t.ctx, IMAGE, fakeReader('coles-a.json').reader);
    const itemTypes = draft.itemTypes.map((m) => m.type);
    const kiwi = draft.receipt.items.findIndex((i) => i.name === 'KIWIFRUIT GOLD');
    itemTypes[kiwi] = 'snack';
    itemTypes[kiwi + 1] = 'meat';

    const r = await saveOk({ itemTypes, target: { kind: 'transaction', transactionId: n19.id } });

    const stored = await storedItems(r.receiptId);
    expect(stored[kiwi]).toEqual(['KIWIFRUIT GOLD', 'snack']);
    expect(stored[kiwi + 1]).toEqual(['KIWIFRUIT 4 FOR $6', 'snack']);
    expect((await learnedRows()).map((x) => [x.nameKey, x.itemType])).toEqual([
      ['KIWIFRUIT GOLD', 'snack'],
    ]);
  });

  it('R21.5: no itemTypes sent → automatic types stored, nothing learned', async () => {
    const r = await saveReceipt(t.ctx, {
      reader: FAKE_READER_ID,
      receipt: X_RAW,
      target: { kind: 'new', accountId: t.h.account('ANZ Joint').id },
    });
    if (!r.ok) throw new Error(r.message);
    expect(await storedItems(r.receiptId)).toEqual([
      ['CHICKEN STOCK', 'meat'],
      ['BANANA 1KG', 'fruit'],
    ]);
    expect(await db.$count(schema.itemTypeRule)).toBe(0);
  });

  it('R21.5: itemTypes not one per item → invalid, nothing written', async () => {
    const r = await saveReceipt(t.ctx, {
      reader: FAKE_READER_ID,
      receipt: X_RAW,
      itemTypes: ['pantry'],
      target: { kind: 'new', accountId: t.h.account('ANZ Joint').id },
    });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(await db.$count(schema.receipt)).toBe(0);
    expect(await db.$count(schema.itemTypeRule)).toBe(0);
  });

  it('R21.5: a save that fails a check (R-C split_failed) learns nothing', async () => {
    const id = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-01',
      amountCents: -5000,
      category: 'Groceries / Supermarket',
      member: 'Home',
    });
    const draft = await scanReceipt(t.ctx, IMAGE, fakeReader('coles-a.json').reader);
    const itemTypes = draft.itemTypes.map(() => 'other' as const);

    const r = await save({ itemTypes, target: { kind: 'transaction', transactionId: id } });
    expect(r).toMatchObject({ ok: false, code: 'split_failed' });
    expect(await db.$count(schema.itemTypeRule)).toBe(0);
  });

  it('R21.5 L-8: an error while writing the receipt (after learning) rolls back the learning table too', async () => {
    const original = db.transaction.bind(db);
    type Tx = Parameters<Parameters<typeof original>[0]>[0];
    vi.spyOn(db, 'transaction').mockImplementation((fn, config) =>
      original((tx) => {
        const failing = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'insert') {
              return (table: Parameters<Tx['insert']>[0]) => {
                if (table === schema.receipt) throw new Error('故意抛错');
                return target.insert(table);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return fn(failing);
      }, config),
    );

    await expect(saveX(t, ['pantry', 'fruit'])).rejects.toThrow('故意抛错');
    vi.restoreAllMocks();

    expect(await db.$count(schema.receipt)).toBe(0);
    expect(await db.$count(schema.transaction)).toBe(0);
    expect(await db.$count(schema.itemTypeRule)).toBe(0);
  });

  it('R21.5 L-9: after L-1, another household scanning X still gets CHICKEN STOCK meat', async () => {
    await saveX(t, ['pantry', 'fruit']);
    await db.delete(schema.householdUser).where(eq(schema.householdUser.userId, TEST_USER.id));
    const other = await createTestHousehold();

    const draft = await scanReceipt(other.ctx, IMAGE, rawReader(X_RAW));
    expect(draft.itemTypes[0]).toEqual({ type: 'meat', source: 'preset' });
  });

  it('R21.8 P-1: R-A with every item changed to other → splits exactly R20.8', async () => {
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
    const n19 = await joint19();
    const txBefore = await getTransaction(n19.id);
    const itemTypes = raw('coles-a.json').items.map(() => 'other' as const);

    await saveOk({ itemTypes, target: { kind: 'transaction', transactionId: n19.id } });

    expect(await splitShape(n19.id)).toEqual(R_A_SPLITS);
    expect(await getTransaction(n19.id)).toEqual(txBefore);
  });

  it('R21.8 P-1: R-B (grocer-b on -32.33) with and without changed types → same splits', async () => {
    const pending = () =>
      insertPending(t, {
        account: 'ANZ Joint',
        date: '2026-09-25',
        amountCents: -3233,
        category: 'Groceries / Supermarket',
        member: 'Home',
      });
    const plain = await pending();
    const typed = await pending();
    const receiptB = raw('grocer-b.json');

    // insertPending 的主拆分算手动改过分类（R20.6），两次都确认覆盖
    await saveOk({
      receipt: receiptB,
      confirmOverwrite: true,
      target: { kind: 'transaction', transactionId: plain },
    });
    await saveOk({
      receipt: receiptB,
      confirmOverwrite: true,
      itemTypes: receiptB.items.map(() => 'snack' as const),
      target: { kind: 'transaction', transactionId: typed },
    });

    const shape = await splitShape(typed);
    expect(shape.map((s) => s.amountCents)).toEqual([-1939, -970, -324]);
    expect(shape).toEqual(await splitShape(plain));
  });

  it('R21.8 P-1: R-E with changed types → same new pending transaction and split as R-E', async () => {
    const receiptE = raw('coles-e.json');
    const r = await saveOk({
      receipt: receiptE,
      itemTypes: receiptE.items.map(() => 'other' as const),
      target: { kind: 'new', accountId: t.h.account('ANZ Joint').id },
    });

    expect(await getTransaction(r.transactionId)).toMatchObject({
      accountId: t.h.account('ANZ Joint').id,
      status: 'pending',
      source: 'receipt',
      date: '2026-09-28',
      amountCents: -2345,
      cardLast4: null,
      merchant: 'COLES',
    });
    expect(await splitShape(r.transactionId)).toEqual([
      {
        primary: true,
        amountCents: -2345,
        category: 'Groceries / Supermarket',
        member: 'Home (category)',
        categorySource: 'rule',
        note: null,
      },
    ]);
  });
});

// ---------- M7.6-6 详情页改类型（R21.6） ----------
// 期望值来自 R21.6 和 fixtures/cases/11-item-types.md D-1 ~ D-4

type StoredJson = {
  items: { name: string; amountCents: number; category: string | null; type?: string }[];
};

async function storedJson(receiptId: string) {
  const [row] = await db.select().from(schema.receipt).where(eq(schema.receipt.id, receiptId));
  return row.parsedJson as StoredJson;
}

// R-A 做完；old = true 时把 parsed_json 的 type 去掉，当作 M7.6 以前存的旧小票
async function afterRA(old: boolean) {
  await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
  const n19 = await joint19();
  const r = await saveOk({ target: { kind: 'transaction', transactionId: n19.id } });
  if (old) {
    const json = await storedJson(r.receiptId);
    await db
      .update(schema.receipt)
      .set({
        parsedJson: {
          ...json,
          items: json.items.map(({ name, amountCents, category }) => ({
            name,
            amountCents,
            category,
          })),
        },
      })
      .where(eq(schema.receipt.id, r.receiptId));
  }
  await db.delete(schema.itemTypeRule);
  const before = {
    json: await storedJson(r.receiptId),
    tx: await getTransaction(n19.id),
  };
  const index = (name: string) => before.json.items.findIndex((i) => i.name === name);
  return { n19, receiptId: r.receiptId, before, index };
}

describeDb('商品类型：详情页改类型（R21.6）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R21.6: getTransactionReceipt returns the stored type; an old receipt gives null', async () => {
    const typed = await afterRA(false);
    expect((await getTransactionReceipt(t.ctx, typed.n19.id))!.items.map((i) => i.type)).toEqual([
      'dairy_egg',
      'fruit',
      'fruit',
      'fruit',
      'household',
      'household',
      'household',
      'pantry',
      'dairy_egg',
    ]);

    await resetBusinessTables();
    t = await createTestHousehold();
    const old = await afterRA(true);
    const shown = await getTransactionReceipt(t.ctx, old.n19.id);
    expect(shown!.items.every((i) => i.type === null)).toBe(true);
  });

  it('R21.6 D-1: old receipt, TASTY CHEESE → dairy_egg: only that item gains a type; splits and transaction as R-A; learned', async () => {
    const { n19, receiptId, before, index } = await afterRA(true);
    const cheese = index('TASTY CHEESE');

    expect(await setReceiptItemType(t.ctx, receiptId, cheese, 'dairy_egg')).toEqual({ ok: true });

    expect(await storedJson(receiptId)).toEqual({
      ...before.json,
      items: before.json.items.map((i, n) => (n === cheese ? { ...i, type: 'dairy_egg' } : i)),
    });
    expect(await splitShape(n19.id)).toEqual(R_A_SPLITS);
    expect(await getTransaction(n19.id)).toEqual(before.tx);
    expect((await learnedRows()).map((r) => [r.nameKey, r.itemType])).toEqual([
      ['TASTY CHEESE', 'dairy_egg'],
    ]);
  });

  it('R21.6 D-2: old receipt, KIWIFRUIT GOLD → fruit: it and the -0.80 get fruit, the others stay untyped', async () => {
    const { receiptId, index } = await afterRA(true);
    const kiwi = index('KIWIFRUIT GOLD');

    expect(await setReceiptItemType(t.ctx, receiptId, kiwi, 'fruit')).toEqual({ ok: true });

    expect((await storedJson(receiptId)).items.map((i) => i.type)).toEqual(
      Array.from({ length: 9 }, (_, n) => (n === kiwi || n === kiwi + 1 ? 'fruit' : undefined)),
    );
  });

  it('R21.6 D-3: SHAMPOO 400ML → other: learned, splits unchanged; the next coles-a scan gives other (learned)', async () => {
    const { n19, receiptId, index } = await afterRA(false);

    expect(await setReceiptItemType(t.ctx, receiptId, index('SHAMPOO 400ML'), 'other')).toEqual({
      ok: true,
    });

    expect((await learnedRows()).map((r) => [r.nameKey, r.itemType])).toEqual([
      ['SHAMPOO 400ML', 'other'],
    ]);
    expect(await splitShape(n19.id)).toEqual(R_A_SPLITS);

    const draft = await scanReceipt(t.ctx, IMAGE, fakeReader('coles-a.json').reader);
    const shampoo = draft.receipt.items.findIndex((i) => i.name === 'SHAMPOO 400ML');
    expect(draft.itemTypes[shampoo]).toEqual({ type: 'other', source: 'learned' });
  });

  it('R21.6 D-4: MILK 3L picked as dairy_egg (same as stored) → nothing learned, parsed_json unchanged', async () => {
    const { receiptId, before, index } = await afterRA(false);

    expect(await setReceiptItemType(t.ctx, receiptId, index('MILK 3L'), 'dairy_egg')).toEqual({
      ok: true,
    });

    expect(await storedJson(receiptId)).toEqual(before.json);
    expect(await db.$count(schema.itemTypeRule)).toBe(0);
  });

  it('R21.4: the negative line, an index out of range or a bad type → invalid, nothing written', async () => {
    const { receiptId, before, index } = await afterRA(false);
    const kiwi = index('KIWIFRUIT GOLD');

    for (const [i, type] of [
      [kiwi + 1, 'meat'],
      [9, 'meat'],
      [-1, 'meat'],
      [0.5, 'meat'],
      [0, 'untyped'],
    ] as const) {
      expect(
        await setReceiptItemType(
          t.ctx,
          receiptId,
          i,
          type as Parameters<typeof setReceiptItemType>[3],
        ),
      ).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(await storedJson(receiptId)).toEqual(before.json);
    expect(await db.$count(schema.itemTypeRule)).toBe(0);
  });

  it("another household's receipt → not_found, nothing written", async () => {
    const { receiptId, before } = await afterRA(false);
    await db.delete(schema.householdUser).where(eq(schema.householdUser.userId, TEST_USER.id));
    const other = await createTestHousehold();

    expect(await setReceiptItemType(other.ctx, receiptId, 0, 'snack')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await setReceiptItemType(other.ctx, 'not-a-uuid', 0, 'snack')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await storedJson(receiptId)).toEqual(before.json);
    expect(await db.$count(schema.itemTypeRule)).toBe(0);
  });
});
