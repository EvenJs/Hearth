// M3-3 导入：写入新交易和匹配 pending（business-rules.md R12 第 1 到 5 步、R4.2、R8.2、R8.3、R1B）
// 期望值来自 fixtures/README.md。R6.2 配对、R6.3 建议、R9 对账在 M3-4，这里不测
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { MemberSource, TransferStatus } from '@/lib/rules/types';
import { importCsv, type ImportInput, type ImportSuccess } from '@/server/imports';
import { readFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import {
  findNumbersInDatabase,
  getSplits,
  getTransaction,
  insertPending,
  listTransactions,
} from './helpers/transactions';

let t: DbTestHousehold;

async function importFixture(
  account: string,
  path: FixturePath,
  extra: Partial<ImportInput> = {},
): Promise<ImportSuccess> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account(account).id,
    fileName: path,
    text: readFixture(path),
    ...extra,
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result;
}

async function batchRow(id: string) {
  const [row] = await db.select().from(schema.importBatch).where(eq(schema.importBatch.id, id));
  return row;
}

// R7：系统分类写 system，用户规则写 rule
const sourceOf = (path: string) => (t.h.category(path).systemKey ? 'system' : 'rule');

// fixtures/README.md 主表：[日期, 金额, merchant, 卡, 分类, 归属人, member_source, transfer_status]
type Row = [string, number, string, string | null, string, string, MemberSource, TransferStatus];
// prettier-ignore
const JOINT: Row[] = [
  ['2026-09-30', 500, 'REVERSAL OF ACCOUNT SERVICING FEE MINIMUM $2000 IN DEPOSITS RECEIVED', null, 'Bank fees', 'Home', 'account', 'none'],
  ['2026-09-30', -500, 'ACCOUNT SERVICING FEE', null, 'Bank fees', 'Home', 'account', 'none'],
  ['2026-09-29', -9840, 'BPAY SEENE', null, 'Home & utilities / Electricity', 'Home', 'category', 'none'],
  ['2026-09-28', -450, 'GONG CHA & HO/SPENCER ST MELBOURNE', '1111', 'Entertainment & eat-out / Bubble tea', 'Male', 'card', 'none'],
  ['2026-09-28', -450, 'GONG CHA & HO/SPENCER ST MELBOURNE', '1111', 'Entertainment & eat-out / Bubble tea', 'Male', 'card', 'none'],
  ['2026-09-25', -15000, 'ATM CBA HAWTHORN', null, 'Cash withdrawal', 'Home', 'account', 'none'],
  ['2026-09-22', 8000, 'PAYID DEPOSIT REF DINNER SPLIT', null, 'Uncategorised', 'Home', 'account', 'none'],
  ['2026-09-22', -6120, 'POCHANA MELBOURNE MELBOURNE', null, 'Entertainment & eat-out / Restaurants', 'Home', 'account', 'none'],
  ['2026-09-20', -3875, 'CROWN ASIAN SPENCER DOCKLANDS', '2222', 'Groceries / Supermarket', 'Home', 'category', 'none'],
  ['2026-09-18', 4580, 'MEDICARE BENEFIT', null, 'Personal & medical / Other', 'Home', 'account', 'none'],
  ['2026-09-15', -50000, 'TRANSFER TO ****0003', null, 'Internal transfer', 'Home', 'account', 'auto'],
  ['2026-09-12', -2500, 'CHARGEFOX PTY LTD NORTH MELBOUR', null, 'Transport & auto / Petrol / EV charging', 'Home', 'account', 'none'],
  ['2026-09-10', 150, 'MELB ASIAN MARKET', null, 'Groceries / Supermarket', 'Home', 'category', 'none'],
  ['2026-09-10', -6230, 'MELB ASIAN MARKET', null, 'Groceries / Supermarket', 'Home', 'category', 'none'],
  ['2026-09-08', -1200, 'UNKNOWN SHOP PTY LTD MELBOURNE', '3333', 'Uncategorised', 'Home', 'account', 'none'],
  ['2026-09-05', -2715, 'EASI AU ****2605', '2222', 'Uncategorised', 'Female', 'card', 'none'],
  ['2026-09-03', 200000, 'TRANSFER FROM ****0002', null, 'Internal transfer', 'Home', 'account', 'auto'],
  ['2026-09-02', 30000, 'TRANSFER FROM ****9999', null, 'Uncategorised', 'Home', 'account', 'none'],
  ['2026-09-01', -5840, 'COLES 0559 MELBOURNE', '1111', 'Groceries / Supermarket', 'Home', 'category', 'none'],
];

describeDb('M3-3 importCsv', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('R12: joint-2026-09.csv on an empty database writes all 19 rows as in fixtures/README', async () => {
    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(result).toMatchObject({
      rowCount: 19,
      insertedCount: 19,
      duplicateCount: 0,
      matchedPendingCount: 0,
    });

    const batch = await batchRow(result.batchId);
    expect(batch).toMatchObject({
      householdId: t.ctx.householdId,
      accountId: t.h.account('ANZ Joint').id,
      fileName: 'anz/joint-2026-09.csv',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
      rowCount: 19,
      insertedCount: 19,
      duplicateCount: 0,
      matchedPendingCount: 0,
      openingBalanceCents: null,
      closingBalanceCents: null,
      reconciled: null,
      createdBy: t.ctx.userId,
    });
    expect(batch.warnings).toEqual({
      balance: [],
      possibleDuplicates: [],
      pendingTransferSplits: [],
      reconciliation: { status: 'none', differenceCents: null },
    });

    const got = await listTransactions(t, 'ANZ Joint');
    expect(got).toHaveLength(19);
    got.forEach((r, i) => {
      const [date, amountCents, merchant, card, category, member, memberSource, transferStatus] =
        JOINT[i];
      const cat = t.h.category(category);
      expect(
        {
          date: r.date,
          amountCents: r.amountCents,
          merchant: r.merchant,
          cardLast4: r.cardLast4,
          balanceCents: r.balanceCents,
          status: r.status,
          source: r.source,
          transferStatus: r.transferStatus,
          transferPairId: r.transferPairId,
          importBatchId: r.importBatchId,
          note: r.note,
          confirmedAt: r.confirmedAt,
          splitCount: r.splitCount,
          splitAmountCents: r.splitAmountCents,
          categoryId: r.categoryId,
          categorySource: r.categorySource,
          isPreTax: r.isPreTax,
          memberId: r.memberId,
          memberSource: r.memberSource,
        },
        `#${i + 1}`,
      ).toEqual({
        date,
        amountCents,
        merchant,
        cardLast4: card,
        balanceCents: null,
        status: 'confirmed',
        source: 'csv',
        transferStatus,
        transferPairId: null,
        importBatchId: result.batchId,
        note: null,
        confirmedAt: null,
        splitCount: 1,
        splitAmountCents: amountCents,
        categoryId: cat.id,
        categorySource: sourceOf(category),
        isPreTax: cat.isPreTaxDefault,
        memberId: t.h.member(member).id,
        memberSource,
      });
      expect(r.dedupeKey, `#${i + 1}`).toMatch(/^[0-9a-f]{64}$/);
      expect(r.rawDescription, `#${i + 1} R2.3`).not.toMatch(/\d{8,}/);
    });

    // R4：#4、#5 是 occurrence 1 和 2，key 不同
    expect(got[3].dedupeKey).not.toBe(got[4].dedupeKey);
  });

  it('R4.2: importing the same file twice skips every row the second time', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const again = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(again).toMatchObject({ rowCount: 19, insertedCount: 0, duplicateCount: 19 });
    expect(await listTransactions(t, 'ANZ Joint')).toHaveLength(19);
  });

  it('R4.2: overlap counts 9 / 3 / 6 and the 3rd GONG CHA is inserted', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');
    expect(result).toMatchObject({
      rowCount: 9,
      insertedCount: 3,
      duplicateCount: 6,
      matchedPendingCount: 0,
    });
    expect(await batchRow(result.batchId)).toMatchObject({
      dateFrom: '2026-09-25',
      dateTo: '2026-10-08',
      rowCount: 9,
      insertedCount: 3,
      duplicateCount: 6,
    });

    const all = await listTransactions(t, 'ANZ Joint');
    expect(all).toHaveLength(22);
    const fresh = all.filter((r) => r.importBatchId === result.batchId);
    const home = t.h.member('Home').id;
    expect(
      fresh.map((r) => [
        r.date,
        r.amountCents,
        r.categoryId,
        r.memberId,
        r.memberSource,
        r.transferStatus,
      ]),
    ).toEqual([
      ['2026-10-08', -4510, t.h.category('Groceries / Supermarket').id, home, 'category', 'none'],
      ['2026-10-03', 200000, t.h.category('Internal transfer').id, home, 'account', 'auto'],
      [
        '2026-09-28',
        -450,
        t.h.category('Entertainment & eat-out / Bubble tea').id,
        t.h.member('Male').id,
        'card',
        'none',
      ],
    ]);
    expect(all.filter((r) => r.merchant.startsWith('GONG CHA'))).toHaveLength(3);
  });

  it('R8.2/R8.3: P1 to P6, 2 pendings confirmed, P3/P4 flagged, P5/P6 stay pending', async () => {
    const pending = (date: string, amountCents: number, category: string, member: string) =>
      insertPending(t, { account: 'ANZ Joint', date, amountCents, category, member });
    const P1 = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-20',
      amountCents: -6120,
      category: 'Entertainment & eat-out / Coffee & tea',
      member: 'Female',
      note: 'P1',
    });
    const P2 = await pending('2026-09-20', -3875, 'Groceries / Supermarket', 'Male');
    const P3 = await pending('2026-09-11', -2500, 'Uncategorised', 'Home');
    const P4 = await pending('2026-09-12', -2500, 'Uncategorised', 'Home');
    const P5 = await pending('2026-09-05', -1000, 'Uncategorised', 'Home');
    const P6 = await pending('2026-09-02', -5840, 'Groceries / Supermarket', 'Home');

    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(result).toMatchObject({
      rowCount: 19,
      insertedCount: 17,
      duplicateCount: 0,
      matchedPendingCount: 2,
    });
    const batch = await batchRow(result.batchId);
    expect(batch).toMatchObject({ insertedCount: 17, matchedPendingCount: 2 });

    // P1 匹配 #8（相差 2 天）：日期、描述换成银行的，保留用户的分类、归属人、备注
    const p1 = await getTransaction(P1);
    expect(p1).toMatchObject({
      status: 'confirmed',
      source: 'manual',
      date: '2026-09-22',
      merchant: 'POCHANA MELBOURNE MELBOURNE',
      cardLast4: null,
      balanceCents: null,
      importBatchId: result.batchId,
      transferStatus: 'none',
      note: 'P1',
    });
    expect(p1.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(p1.rawDescription).not.toBe('MANUAL ENTRY');
    expect(p1.confirmedAt).toBeInstanceOf(Date);
    expect(
      (await getSplits(P1)).map((s) => [
        s.categoryId,
        s.categorySource,
        s.memberId,
        s.memberSource,
      ]),
    ).toEqual([
      [
        t.h.category('Entertainment & eat-out / Coffee & tea').id,
        'manual',
        t.h.member('Female').id,
        'manual',
      ],
    ]);

    // P2 匹配 #9（相差 0 天）
    expect(await getTransaction(P2)).toMatchObject({
      status: 'confirmed',
      date: '2026-09-20',
      merchant: 'CROWN ASIAN SPENCER DOCKLANDS',
      cardLast4: '2222',
    });
    expect((await getSplits(P2))[0]).toMatchObject({
      memberId: t.h.member('Male').id,
      memberSource: 'manual',
    });

    // P3、P4：#12 有 2 个候选 → 正常新增，记进 possibleDuplicates
    const joint = await listTransactions(t, 'ANZ Joint');
    const n12 = joint.filter((r) => r.source === 'csv' && r.amountCents === -2500);
    expect(n12).toHaveLength(1);
    const warnings = batch.warnings as ImportSuccess['warnings'];
    expect(warnings.possibleDuplicates).toHaveLength(1);
    expect(warnings.possibleDuplicates[0].transactionId).toBe(n12[0].id);
    expect([...warnings.possibleDuplicates[0].pendingIds].sort()).toEqual([P3, P4].sort());
    expect(result.warnings).toEqual(warnings);

    // P3 到 P6 没被动过
    for (const id of [P3, P4, P5, P6]) {
      expect(await getTransaction(id), id).toMatchObject({
        status: 'pending',
        dedupeKey: null,
        importBatchId: null,
        confirmedAt: null,
        merchant: 'MANUAL ENTRY',
      });
    }
    // P6：#19（09-01）早于 pending（09-02）→ 不匹配，#19 新增
    expect((await getTransaction(P6)).date).toBe('2026-09-02');
    expect(joint.filter((r) => r.source === 'csv' && r.amountCents === -5840)).toHaveLength(1);

    // 17 笔新增 + 2 笔确认 + 4 笔还是 pending
    expect(joint).toHaveLength(23);
  });

  it('P10 / R8.3 exception: pending confirmed by a transfer row becomes auto + Internal transfer', async () => {
    const p10 = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-14',
      amountCents: -50000,
      category: 'Entertainment & eat-out / Restaurants',
      member: 'Female',
      note: '给老婆',
    });

    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(result).toMatchObject({ rowCount: 19, insertedCount: 18, matchedPendingCount: 1 });

    expect(await getTransaction(p10)).toMatchObject({
      status: 'confirmed',
      source: 'manual',
      date: '2026-09-15',
      merchant: 'TRANSFER TO ****0003',
      transferStatus: 'auto',
      transferPairId: null,
      note: '给老婆',
    });
    const internal = t.h.systemCategory('internal_transfer');
    expect(
      (await getSplits(p10)).map((s) => [
        s.isPrimary,
        s.amountCents,
        s.categoryId,
        s.categorySource,
        s.isPreTax,
        s.memberId,
        s.memberSource,
      ]),
    ).toEqual([
      [
        true,
        -50000,
        internal.id,
        'system',
        internal.isPreTaxDefault,
        t.h.member('Female').id,
        'manual',
      ],
    ]);

    // 返回结果里带上对方账户，给 M3-4 的 R6.2 用
    expect(result.transactions.find((x) => x.id === p10)).toEqual({
      id: p10,
      kind: 'confirmed_pending',
      transferAccountId: t.h.account('CBA Female').id,
    });
  });

  it('R8.3 exception: a pending with several splits is confirmed, splits untouched, flagged', async () => {
    const id = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-14',
      amountCents: -50000,
      category: 'Entertainment & eat-out / Restaurants',
      member: 'Female',
      extraSplits: [{ amountCents: -10000, category: 'Groceries / Supermarket' }],
    });
    const before = await getSplits(id);

    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(await getTransaction(id)).toMatchObject({
      status: 'confirmed',
      date: '2026-09-15',
      transferStatus: 'none',
    });
    expect(await getSplits(id)).toEqual(before);
    expect(result.warnings.pendingTransferSplits).toEqual([id]);
    expect((await batchRow(result.batchId)).warnings).toEqual(result.warnings);
  });

  it('P9 / R1: ANZ Plus Male cannot import a CSV, nothing is written', async () => {
    const result = await importCsv(t.ctx, {
      accountId: t.h.account('ANZ Plus Male').id,
      fileName: 'joint.csv',
      text: readFixture('anz/joint-2026-09.csv'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_importable' });
    expect(await db.$count(schema.importBatch)).toBe(0);
    expect(await db.$count(schema.transaction)).toBe(0);
  });

  it('rejects archived accounts and accounts from another household', async () => {
    await db
      .update(schema.financialAccount)
      .set({ isArchived: true })
      .where(eq(schema.financialAccount.id, t.h.account('ANZ Male').id));
    const archived = await importCsv(t.ctx, {
      accountId: t.h.account('ANZ Male').id,
      fileName: 'me.csv',
      text: readFixture('anz/me-2026-09.csv'),
    });
    expect(archived).toMatchObject({ ok: false, reason: 'not_importable' });

    const other = await importCsv(
      { ...t.ctx, householdId: '00000000-0000-4000-8000-000000000000' },
      {
        accountId: t.h.account('ANZ Joint').id,
        fileName: 'joint.csv',
        text: readFixture('anz/joint-2026-09.csv'),
      },
    );
    expect(other).toMatchObject({ ok: false, reason: 'not_importable' });
    expect(await db.$count(schema.importBatch)).toBe(0);
    expect(await db.$count(schema.transaction)).toBe(0);
  });

  it('R1.0-6: a parse error returns the line number and writes nothing', async () => {
    const result = await importCsv(t.ctx, {
      accountId: t.h.account('ANZ Joint').id,
      fileName: 'bad.csv',
      text: readFixture('anz/invalid-date.csv'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'parse', line: 1 });
    expect(await db.$count(schema.importBatch)).toBe(0);
    expect(await db.$count(schema.transaction)).toBe(0);
  });

  it('ANZ: opening/closing stored when both given, rejected when only one is', async () => {
    const one = await importCsv(t.ctx, {
      accountId: t.h.account('ANZ Joint').id,
      fileName: 'joint.csv',
      text: readFixture('anz/joint-2026-09.csv'),
      openingBalanceCents: 100000,
    });
    expect(one).toMatchObject({ ok: false, reason: 'invalid_balance' });
    expect(await db.$count(schema.importBatch)).toBe(0);

    const both = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv', {
      openingBalanceCents: 100000,
      closingBalanceCents: 123456,
    });
    expect(both).toMatchObject({ openingBalanceCents: 100000, closingBalanceCents: 123456 });
    expect(await batchRow(both.batchId)).toMatchObject({
      openingBalanceCents: 100000,
      closingBalanceCents: 123456,
      // M3-4 起跑 R9：这两个数是随便填的，对不上
      reconciled: false,
    });
  });

  it('R1B: female-2026-09.csv stores balances and derives opening/closing (R1B.2)', async () => {
    const result = await importFixture('CBA Female', 'cba/female-2026-09.csv', {
      // CBA 传进来的期初期末忽略，以 R1B.2 算出来的为准
      openingBalanceCents: 1,
      closingBalanceCents: 2,
    });
    expect(result).toMatchObject({
      rowCount: 20,
      insertedCount: 20,
      duplicateCount: 0,
      openingBalanceCents: 1000000,
      closingBalanceCents: 1156159,
    });
    expect(await batchRow(result.batchId)).toMatchObject({
      openingBalanceCents: 1000000,
      closingBalanceCents: 1156159,
      reconciled: true,
    });
    expect(result.warnings.balance).toEqual([]);

    const rows = await listTransactions(t, 'CBA Female');
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.balanceCents !== null)).toBe(true);
    // #12、#13 同一天同金额，余额不同，都插入
    expect(rows.filter((r) => r.merchant === 'TOWER SUSHI & GOURM MELBOURNE')).toHaveLength(2);
  });

  it('R1B.1: broken-balance.csv inserts 3 rows with 2 balance warnings', async () => {
    const result = await importFixture('CBA Female', 'cba/broken-balance.csv');
    expect(result).toMatchObject({
      rowCount: 3,
      insertedCount: 3,
      openingBalanceCents: 944925,
      closingBalanceCents: 1156159,
    });
    expect(result.warnings.balance.map((w) => [w.line, w.nextLine])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    const stored = (await batchRow(result.batchId)).warnings as ImportSuccess['warnings'];
    expect(stored.balance).toEqual(result.warnings.balance);
  });

  it('R12: an error halfway through rolls back everything, including the confirmed pending', async () => {
    const p1 = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-20',
      amountCents: -6120,
      category: 'Entertainment & eat-out / Restaurants',
      member: 'Female',
    });
    const before = await getTransaction(p1);

    // import_batch、pending 确认、transaction 都写完以后，写拆分时抛错
    const original = db.transaction.bind(db);
    type Tx = Parameters<Parameters<typeof original>[0]>[0];
    vi.spyOn(db, 'transaction').mockImplementation((fn, config) =>
      original((tx) => {
        const failing = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'insert') {
              return (table: Parameters<Tx['insert']>[0]) => {
                if (table === schema.transactionSplit) throw new Error('故意抛错');
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

    await expect(
      importCsv(t.ctx, {
        accountId: t.h.account('ANZ Joint').id,
        fileName: 'joint.csv',
        text: readFixture('anz/joint-2026-09.csv'),
      }),
    ).rejects.toThrow('故意抛错');
    vi.restoreAllMocks();

    expect(await db.$count(schema.importBatch)).toBe(0);
    expect(await db.$count(schema.transaction)).toBe(1);
    expect(await getTransaction(p1)).toEqual(before);
  });

  it('R2.3: no full account or card numbers anywhere in the database', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');
    await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    await importFixture('CBA Female', 'cba/female-2026-09.csv');
    // 确认扫描的库里真的有数据
    expect(await db.$count(schema.transaction)).toBe(19 + 3 + 4 + 20);

    // prettier-ignore
    const found = await findNumbersInDatabase([
      // fixtures/README.md joint
      '400000002', '012345400000003', '499999999', '280672605',
      // fixtures/README.md cba
      '5512345678901234', '12345678901234567890', '111122223333444000', '123456789', '01092026',
    ]);
    expect(found).toEqual([]);
  });
});
