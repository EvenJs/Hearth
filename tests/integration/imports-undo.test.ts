// M3-5 撤销导入（business-rules.md R12.1）
// 期望值来自 fixtures/README.md "撤销导入用例" U1 到 U6
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import {
  getUndoPreview,
  importCsv,
  undoImport,
  type ImportInput,
  type ImportSuccess,
  type UndoPreview,
} from '@/server/imports';
import { readFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { getTransaction, insertPending, listTransactions } from './helpers/transactions';

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

async function preview(batchId: string) {
  const p = await getUndoPreview(t.ctx, batchId);
  if (!p.ok) throw new Error(`不能撤销: ${p.message}`);
  return p;
}

async function undo(batchId: string) {
  const r = await undoImport(t.ctx, batchId);
  if (!r.ok) throw new Error(`撤销失败: ${r.message}`);
  return r;
}

async function txIn(account: string, date: string, amountCents: number) {
  const rows = (await listTransactions(t, account)).filter(
    (r) => r.date === date && r.amountCents === amountCents,
  );
  expect(rows, `${account} ${date} ${amountCents}`).toHaveLength(1);
  return rows[0];
}
const J7 = () => txIn('ANZ Joint', '2026-09-22', 8000);
const J11 = () => txIn('ANZ Joint', '2026-09-15', -50000);
const J17 = () => txIn('ANZ Joint', '2026-09-03', 200000);
const PAYID = () => txIn('ANZ Male', '2026-09-21', -8000);
const C3 = () => txIn('CBA Female', '2026-09-25', 300000);
const C10 = () => txIn('CBA Female', '2026-09-16', 50000);
const C15 = () => txIn('CBA Female', '2026-09-08', 2250);

// F8 还没做页面：直接改库模拟手动改主拆分的分类
async function setPrimaryCategory(txId: string, path: string) {
  const cat = t.h.category(path);
  await db
    .update(schema.transactionSplit)
    .set({ categoryId: cat.id, categorySource: 'manual', isPreTax: cat.isPreTaxDefault })
    .where(eq(schema.transactionSplit.transactionId, txId));
}

// 每个用例做完：没有 transfer_pair_id 指向不存在的交易，配对两边互相指向
async function expectPairsConsistent() {
  const rows = await db
    .select({ id: schema.transaction.id, pair: schema.transaction.transferPairId })
    .from(schema.transaction);
  const byId = new Map(rows.map((r) => [r.id, r.pair]));
  for (const r of rows) {
    if (r.pair === null) continue;
    expect(byId.has(r.pair), `${r.id} 指向不存在的 ${r.pair}`).toBe(true);
    expect(byId.get(r.pair), r.id).toBe(r.id);
  }
}

// 整个家庭的交易和拆分，去掉 id 和时间戳，配对换成对方的 key，用来比"和第一次一样"
async function snapshot() {
  const accountName = new Map(t.h.accounts.map((a) => [a.id, a.name]));
  const txs = await db
    .select()
    .from(schema.transaction)
    .where(eq(schema.transaction.householdId, t.ctx.householdId));
  const splits =
    txs.length === 0
      ? []
      : await db
          .select()
          .from(schema.transactionSplit)
          .where(
            inArray(
              schema.transactionSplit.transactionId,
              txs.map((x) => x.id),
            ),
          )
          .orderBy(asc(schema.transactionSplit.amountCents));
  const key = (x: (typeof txs)[number]) =>
    [accountName.get(x.accountId), x.date, x.amountCents, x.merchant, x.dedupeKey].join('|');
  const keyById = new Map(txs.map((x) => [x.id, key(x)]));
  return txs
    .map((x) => ({
      key: key(x),
      rawDescription: x.rawDescription,
      cardLast4: x.cardLast4,
      balanceCents: x.balanceCents,
      status: x.status,
      source: x.source,
      transferStatus: x.transferStatus,
      pair: x.transferPairId ? keyById.get(x.transferPairId) : null,
      inBatch: x.importBatchId !== null,
      confirmed: x.confirmedAt !== null,
      note: x.note,
      splits: splits
        .filter((s) => s.transactionId === x.id)
        .map((s) => ({
          amountCents: s.amountCents,
          categoryId: s.categoryId,
          memberId: s.memberId,
          categorySource: s.categorySource,
          memberSource: s.memberSource,
          isPrimary: s.isPrimary,
          isPreTax: s.isPreTax,
          note: s.note,
        })),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const batchExists = async (id: string) =>
  (await db.$count(schema.importBatch, eq(schema.importBatch.id, id))) > 0;

const uncategorized = () => t.h.systemCategory('uncategorized').id;
const internal = () => t.h.systemCategory('internal_transfer').id;

describeDb('M3-5 撤销导入（R12.1）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R12.1 U1: only the latest import of an account can be undone; undo overlap deletes its 3 rows', async () => {
    const jointBatch = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const afterJoint = await snapshot();
    const overlap = await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');
    const afterOverlap = await snapshot();

    // 拒绝：ANZ Joint 最近一次导入是 overlap
    expect(await getUndoPreview(t.ctx, jointBatch.batchId)).toMatchObject({
      ok: false,
      reason: 'not_latest',
    });
    expect(await undoImport(t.ctx, jointBatch.batchId)).toMatchObject({
      ok: false,
      reason: 'not_latest',
    });
    expect(await snapshot()).toEqual(afterOverlap);

    expect(await preview(overlap.batchId)).toMatchObject({
      deleteCount: 3,
      prompt: { manualEditedCount: 0, confirmedPendingCount: 0, needsConfirm: false },
    });
    const result = await undo(overlap.batchId);
    expect(result).toMatchObject({ deletedCount: 3, restoredPendingCount: 0, counterparts: [] });

    // 删掉 10/08 WOOLWORTHS、10/03 FROM ****0002、GONG CHA 第 3 笔；joint 的 19 笔不变
    expect(await listTransactions(t, 'ANZ Joint')).toHaveLength(19);
    expect(await snapshot()).toEqual(afterJoint);
    expect(await batchExists(overlap.batchId)).toBe(false);
    await expectPairsConsistent();

    // 现在 joint 主文件变成最近一次，可以撤销
    expect((await getUndoPreview(t.ctx, jointBatch.batchId)).ok).toBe(true);

    // 再导入 overlap，和第一次一样
    await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');
    expect(await snapshot()).toEqual(afterOverlap);
    await expectPairsConsistent();
  });

  it('R12.1 U2: undo me → #7 suggested is reset, #17 stays auto; re-import me gives the same result', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');
    const beforeMe = await snapshot();
    const me = await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    const afterMe = await snapshot();

    // 不弹窗（没有手动改过的）
    expect(await preview(me.batchId)).toMatchObject({
      deleteCount: 4,
      prompt: { manualEditedCount: 0, confirmedPendingCount: 0, needsConfirm: false },
    });
    const result = await undo(me.batchId);
    expect(result.deletedCount).toBe(4);
    expect(result.counterparts.map((c) => [c.case, c.action]).sort()).toEqual([
      ['auto_still_detected', 'unpair'],
      ['suggested', 'reset'],
    ]);

    expect(await listTransactions(t, 'ANZ Male')).toHaveLength(0);
    // Joint #7：suggested → none，Uncategorised，system，Home（account），配对清空
    expect(await J7()).toMatchObject({
      transferStatus: 'none',
      transferPairId: null,
      categoryId: uncategorized(),
      categorySource: 'system',
      memberId: t.h.member('Home').id,
      memberSource: 'account',
    });
    // Joint #17：****0002 对上 ANZ Male → 保持 auto 和 Internal transfer，只清空配对
    expect(await J17()).toMatchObject({
      transferStatus: 'auto',
      transferPairId: null,
      categoryId: internal(),
    });
    expect(await snapshot()).toEqual(beforeMe);
    await expectPairsConsistent();

    // 再导入 me：#7 和 PAYID PAYMENT 重新被建议，#17 重新配对
    await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    expect(await snapshot()).toEqual(afterMe);
    expect((await J7()).transferPairId).toBe((await PAYID()).id);
    expect((await J17()).transferPairId).not.toBeNull();
    await expectPairsConsistent();
  });

  it('R12.1 U3: undo cba after the two manual edits → prompt 2 manual; joint #11 stays auto', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');
    await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    const beforeCba = await snapshot();
    const cba = await importFixture('CBA Female', 'cba/female-2026-09.csv');
    const afterCba = await snapshot();

    // fixtures/README "然后手动操作"
    await setPrimaryCategory((await C3()).id, 'Income / Contract income (B2B)');
    await setPrimaryCategory((await C15()).id, 'Entertainment & eat-out / Restaurants');

    expect(await preview(cba.batchId)).toMatchObject({
      deleteCount: 20,
      prompt: { manualEditedCount: 2, confirmedPendingCount: 0, needsConfirm: true },
    });
    const result = await undo(cba.batchId);
    expect(result.deletedCount).toBe(20);
    expect(result.counterparts).toEqual([
      { id: (await J11()).id, case: 'auto_still_detected', action: 'unpair' },
    ]);

    expect(await listTransactions(t, 'CBA Female')).toHaveLength(0);
    // Joint #11：****0003 对上 CBA Female → 保持 auto，只清空配对
    expect(await J11()).toMatchObject({
      transferStatus: 'auto',
      transferPairId: null,
      categoryId: internal(),
    });
    // me 时的建议不受影响
    expect((await J7()).transferStatus).toBe('suggested');
    expect(await snapshot()).toEqual(beforeCba);
    await expectPairsConsistent();

    // 再导入 cba：和第一次导入后一样（手动改的不会回来）
    await importFixture('CBA Female', 'cba/female-2026-09.csv');
    expect(await snapshot()).toEqual(afterCba);
    await expectPairsConsistent();
  });

  it('R12.1 U4: joint → cba, undo joint → CBA #10 (PayID) is reset to Uncategorised; re-import joint pairs again', async () => {
    const joint = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('CBA Female', 'cba/female-2026-09.csv');
    const afterBoth = await snapshot();

    expect(await preview(joint.batchId)).toMatchObject({
      deleteCount: 19,
      prompt: { manualEditedCount: 0, confirmedPendingCount: 0, needsConfirm: false },
    });
    await undo(joint.batchId);

    expect(await listTransactions(t, 'ANZ Joint')).toHaveLength(0);
    // CBA #10：重跑 R6.1 认不出 → none，Uncategorised，system，Female（account），配对清空
    expect(await C10()).toMatchObject({
      transferStatus: 'none',
      transferPairId: null,
      categoryId: uncategorized(),
      categorySource: 'system',
      isPreTax: t.h.systemCategory('uncategorized').isPreTaxDefault,
      memberId: t.h.member('Female').id,
      memberSource: 'account',
    });
    await expectPairsConsistent();

    // 再导入 joint：#11 和 CBA #10 重新配对，CBA #10 变回 auto + Internal transfer
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(await C10()).toMatchObject({
      transferStatus: 'auto',
      transferPairId: (await J11()).id,
      categoryId: internal(),
    });
    expect(await snapshot()).toEqual(afterBoth);
    await expectPairsConsistent();
  });

  it('R12.1 U5: confirmed suggestion, undo me → prompt 1 manual; #7 confirmed is reset', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');
    const beforeMe = await snapshot();
    const me = await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    const afterMe = await snapshot();

    // F8 确认建议（还没做页面，直接改库）：两边 confirmed，分类 Internal transfer，manual
    for (const tx of [await J7(), await PAYID()]) {
      await db
        .update(schema.transaction)
        .set({ transferStatus: 'confirmed' })
        .where(eq(schema.transaction.id, tx.id));
      await setPrimaryCategory(tx.id, 'Internal transfer');
    }

    expect(await preview(me.batchId)).toMatchObject({
      deleteCount: 4,
      prompt: { manualEditedCount: 1, confirmedPendingCount: 0, needsConfirm: true },
    });
    await undo(me.batchId);

    // Joint #7：confirmed → none，Uncategorised，system，配对清空
    expect(await J7()).toMatchObject({
      transferStatus: 'none',
      transferPairId: null,
      categoryId: uncategorized(),
      categorySource: 'system',
      memberId: t.h.member('Home').id,
      memberSource: 'account',
    });
    expect(await snapshot()).toEqual(beforeMe);
    await expectPairsConsistent();

    await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    expect(await snapshot()).toEqual(afterMe);
    await expectPairsConsistent();
  });

  it('R12.1 U6: P1 to P6 then joint, undo joint → P1, P2 back to pending with the bank date; 17 inserted deleted', async () => {
    const pending = (date: string, amountCents: number) =>
      insertPending(t, {
        account: 'ANZ Joint',
        date,
        amountCents,
        category: 'Groceries / Supermarket',
        member: 'Home',
      });
    const P1 = await pending('2026-09-20', -6120);
    const P2 = await pending('2026-09-20', -3875);
    await pending('2026-09-11', -2500); // P3
    await pending('2026-09-12', -2500); // P4
    await pending('2026-09-05', -1000); // P5
    await pending('2026-09-02', -5840); // P6

    const joint = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(joint).toMatchObject({ insertedCount: 17, matchedPendingCount: 2 });
    const afterJoint = await snapshot();

    expect(await preview(joint.batchId)).toMatchObject({
      deleteCount: 17,
      prompt: { manualEditedCount: 0, confirmedPendingCount: 2, needsConfirm: true },
    });
    expect(await undo(joint.batchId)).toMatchObject({
      deletedCount: 17,
      restoredPendingCount: 2,
    });

    // 日期保留银行的（09-22、09-20），dedupe_key、import_batch_id、confirmed_at 清空
    for (const [id, date] of [
      [P1, '2026-09-22'],
      [P2, '2026-09-20'],
    ]) {
      expect(await getTransaction(id)).toMatchObject({
        status: 'pending',
        date,
        dedupeKey: null,
        importBatchId: null,
        confirmedAt: null,
        transferPairId: null,
      });
    }
    const left = await listTransactions(t, 'ANZ Joint');
    expect(left).toHaveLength(6);
    expect(left.every((r) => r.status === 'pending' && r.source === 'manual')).toBe(true);
    // 拆分保留用户录入的
    expect(left.every((r) => r.categorySource === 'manual' && r.memberSource === 'manual')).toBe(
      true,
    );
    expect(await batchExists(joint.batchId)).toBe(false);
    await expectPairsConsistent();

    // 再导入 joint：P1、P2 重新被确认，结果和第一次一样
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(await snapshot()).toEqual(afterJoint);
    await expectPairsConsistent();
  });

  it('R12.1 + R8.3: P10 confirmed as a transfer and paired with CBA #10, undo joint → P10 stays auto unpaired, CBA #10 reset', async () => {
    const p10 = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-14',
      amountCents: -50000,
      category: 'Entertainment & eat-out / Restaurants',
      member: 'Female',
      note: '给老婆',
    });
    const joint = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('CBA Female', 'cba/female-2026-09.csv');
    expect((await getTransaction(p10)).transferPairId).toBe((await C10()).id);

    expect(await preview(joint.batchId)).toMatchObject({
      deleteCount: 18,
      prompt: { manualEditedCount: 0, confirmedPendingCount: 1, needsConfirm: true },
    });
    await undo(joint.batchId);

    // 被 R8.3 例外改成转账的：transfer_status 保持 auto，只清空配对；分类恢复不了
    expect(await getTransaction(p10)).toMatchObject({
      status: 'pending',
      transferStatus: 'auto',
      transferPairId: null,
      note: '给老婆',
    });
    expect(await C10()).toMatchObject({
      transferStatus: 'none',
      transferPairId: null,
      categoryId: uncategorized(),
    });
    await expectPairsConsistent();
  });

  it('R12.1: a batch of another household, or one that no longer exists, is not found', async () => {
    const joint = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    // 别的家庭：household_user.user_id 唯一，测试用户只能在一个家庭里，直接换 householdId
    const other = { ...t.ctx, householdId: randomUUID() };
    const notFound: Partial<UndoPreview> = { ok: false, reason: 'not_found' };
    expect(await getUndoPreview(other, joint.batchId)).toMatchObject(notFound);
    expect(await undoImport(other, joint.batchId)).toMatchObject(notFound);
    expect(await listTransactions(t, 'ANZ Joint')).toHaveLength(19);

    await undo(joint.batchId);
    expect(await undoImport(t.ctx, joint.batchId)).toMatchObject(notFound);
  });
});
