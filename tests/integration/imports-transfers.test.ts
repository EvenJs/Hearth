// M3-4 导入：转账配对、建议和对账（business-rules.md R12 第 6 到 10 步、R6.2、R6.3、R9、R8.4）
// 期望值来自 fixtures/README.md
import { and, eq, isNotNull } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
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
  getTransaction,
  insertPending,
  listTransactions,
  type TxRow,
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

const sourceOf = (path: string) => (t.h.category(path).systemKey ? 'system' : 'rule');

// [日期, 金额, merchant, 卡, 分类, 归属人, member_source, transfer_status]
type Row = [string, number, string, string | null, string, string, MemberSource, TransferStatus];

// listTransactions 按日期新的在前、同一天金额大的在前；期望值也按同样的顺序排
const byDateAmount = (a: Row, b: Row) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : b[1] - a[1]);

function checkRows(got: TxRow[], expected: Row[], withMerchant = true) {
  const sorted = [...expected].sort(byDateAmount);
  expect(got).toHaveLength(sorted.length);
  got.forEach((r, i) => {
    const [date, amountCents, merchant, card, category, member, memberSource, transferStatus] =
      sorted[i];
    const cat = t.h.category(category);
    expect(
      {
        date: r.date,
        amountCents: r.amountCents,
        ...(withMerchant ? { merchant: r.merchant, cardLast4: r.cardLast4 } : {}),
        categoryId: r.categoryId,
        categorySource: r.categorySource,
        isPreTax: r.isPreTax,
        memberId: r.memberId,
        memberSource: r.memberSource,
        transferStatus: r.transferStatus,
      },
      `${date} ${amountCents}`,
    ).toEqual({
      date,
      amountCents,
      ...(withMerchant ? { merchant, cardLast4: card } : {}),
      categoryId: cat.id,
      categorySource: sourceOf(category),
      isPreTax: cat.isPreTaxDefault,
      memberId: t.h.member(member).id,
      memberSource,
      transferStatus,
    });
  });
}

// fixtures/README.md "再导入 me-2026-09.csv"（README 没给 merchant，不比）
// prettier-ignore
const ME: Row[] = [
  ['2026-09-21', -8000, '', null, 'Uncategorised', 'Male', 'account', 'suggested'],
  ['2026-09-14', -3000, '', null, 'Transport & auto / Public transport', 'Male', 'account', 'none'],
  ['2026-09-03', -200000, '', null, 'Internal transfer', 'Male', 'account', 'auto'],
  ['2026-09-01', 520000, '', null, 'Income / Salary', 'Male', 'account', 'none'],
];

// fixtures/README.md "导入 cba/female-2026-09.csv"，按 joint → overlap → me → cba 导入后
// prettier-ignore
const CBA: Row[] = [
  ['2026-09-30', 1234, 'CREDIT INTEREST', null, 'Income / Interest', 'Female', 'account', 'none'],
  ['2026-09-28', -90000, 'BPAY TAX OFFICE PAYMENTS', null, 'Income / Tax (ATO)', 'Female', 'account', 'none'],
  ['2026-09-25', 300000, 'FAST TRANSFER FROM ACME TRADING PTY LTD INVOICE 0925', null, 'Uncategorised', 'Female', 'account', 'none'],
  ['2026-09-24', 100000, 'TRANSFER FROM XX7777 HOME', null, 'Internal transfer', 'Female', 'account', 'auto'],
  ['2026-09-22', -45560, 'BPAY DEFT PAYMENTS', null, 'Home & utilities / Body corporate fees', 'Home', 'category', 'none'],
  ['2026-09-20', 400, 'CBA YELLO HLPCKG CSHBK', null, 'Income / Other', 'Female', 'account', 'none'],
  ['2026-09-19', 3860, 'DIRECT CREDIT 002221 MCARE BENEFITS ****6789 ABCD', null, 'Personal & medical / Other', 'Female', 'account', 'none'],
  ['2026-09-16', -6490, 'CROWN ASIAN SPENCER DOCKLANDS', '5555', 'Groceries / Supermarket', 'Home', 'category', 'none'],
  ['2026-09-16', -29840, 'DIRECT DEBIT 000793 BUPA AUSTRALIA ****4000', null, 'Insurance & financial / Personal & life insurance', 'Home', 'category', 'none'],
  ['2026-09-16', 50000, 'FAST TRANSFER FROM TEST HOLDER JOINT', null, 'Internal transfer', 'Female', 'account', 'auto'],
  ['2026-09-15', -2280, 'KIS HAIR MELBOURNE', '4444', 'Personal & medical / Hair & beauty', 'Female', 'account', 'none'],
  ['2026-09-12', -300, 'TOWER SUSHI & GOURM MELBOURNE', null, 'Uncategorised', 'Female', 'account', 'none'],
  ['2026-09-12', -300, 'TOWER SUSHI & GOURM MELBOURNE', null, 'Uncategorised', 'Female', 'account', 'none'],
  ['2026-09-10', -7500, 'LIGHTNING BROADBAND', null, 'Home & utilities / Internet', 'Home', 'category', 'none'],
  ['2026-09-08', 2250, 'FAST TRANSFER FROM OTHER FRIEND DINNER', null, 'Uncategorised', 'Female', 'account', 'none'],
  ['2026-09-08', -4500, 'TRANSFER TO TEST FRIEND EAT EAT', null, 'Entertainment & eat-out / Restaurants', 'Female', 'account', 'none'],
  ['2026-09-05', -680, 'OVERLAY COFFEE MELBOURNE', '5555', 'Entertainment & eat-out / Coffee & tea', 'Female', 'account', 'none'],
  ['2026-09-03', -7135, 'BPAY SEENE', null, 'Home & utilities / Electricity', 'Home', 'category', 'none'],
  ['2026-09-02', -148000, 'LOAN REPAYMENT LN REPAY ****6789', null, 'Home & utilities / Mortgage', 'Home', 'category', 'none'],
  ['2026-09-01', 41000, 'SALARY EXAMPLE SCHOOL WAGES ****2026', null, 'Income / Salary', 'Female', 'account', 'none'],
];

// joint 主文件里的一笔，按日期和金额找（fixtures/README 的 #）
async function jointTx(date: string, amountCents: number) {
  const rows = (await listTransactions(t, 'ANZ Joint')).filter(
    (r) => r.date === date && r.amountCents === amountCents,
  );
  expect(rows, `joint ${date} ${amountCents}`).toHaveLength(1);
  return rows[0];
}
async function txIn(account: string, date: string, amountCents: number) {
  const rows = (await listTransactions(t, account)).filter(
    (r) => r.date === date && r.amountCents === amountCents,
  );
  expect(rows, `${account} ${date} ${amountCents}`).toHaveLength(1);
  return rows[0];
}
const J7 = () => jointTx('2026-09-22', 8000);
const J11 = () => jointTx('2026-09-15', -50000);
const J17 = () => jointTx('2026-09-03', 200000);
const PAYID = () => txIn('ANZ Male', '2026-09-21', -8000);
const ME0309 = () => txIn('ANZ Male', '2026-09-03', -200000);
const C10 = () => txIn('CBA Female', '2026-09-16', 50000);

// 每个用例做完：配对两边互相指向，没有指向不存在的交易
async function expectPairsConsistent() {
  const paired = await db
    .select({ id: schema.transaction.id, pair: schema.transaction.transferPairId })
    .from(schema.transaction)
    .where(isNotNull(schema.transaction.transferPairId));
  const byId = new Map(paired.map((p) => [p.id, p.pair]));
  for (const p of paired) expect(byId.get(p.pair!), p.id).toBe(p.id);
}

describeDb('M3-4 importCsv：转账配对、建议和对账', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('joint → overlap → me → cba: everything matches fixtures/README', async () => {
    const joint = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    // #11 → CBA Female、#17 → ANZ Male，对方还没导入，配不上
    expect(joint.transfers).toEqual({ pairs: [], suggestions: [] });
    expect(joint.uncategorizedCount).toBe(4); // #7、#15、#16、#18
    expect(joint.pendingToCheck).toEqual([]);
    expect(joint.reconciliation).toEqual({ status: 'none', differenceCents: null });
    expect((await batchRow(joint.batchId)).reconciled).toBeNull();

    const overlap = await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');
    expect(overlap.transfers).toEqual({ pairs: [], suggestions: [] });

    // ---------- me ----------
    const me = await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    checkRows(await listTransactions(t, 'ANZ Male'), ME, false);
    expect(me.uncategorizedCount).toBe(1); // PAYID PAYMENT（suggested 确认前还是未分类）

    // R6.2：joint #17 和 me 03/09 配对，两边都是 auto，不用改
    const [j17, me0309] = [await J17(), await ME0309()];
    expect(j17.transferPairId).toBe(me0309.id);
    expect(me0309.transferPairId).toBe(j17.id);
    expect(j17.transferStatus).toBe('auto');
    // 两边都是 auto、同一天，谁当 a 取决于 id 顺序，只比这一对是谁
    expect(me.transfers.pairs).toHaveLength(1);
    expect(me.transfers.pairs[0]).toMatchObject({
      counterpartUpdate: null,
      manualCategoryKept: false,
    });
    expect([me.transfers.pairs[0].aId, me.transfers.pairs[0].bId].sort()).toEqual(
      [j17.id, me0309.id].sort(),
    );

    // R6.3：joint #7 和 PAYID PAYMENT 互为 suggested，分类还是未分类
    const [j7, payid] = [await J7(), await PAYID()];
    const uncategorized = t.h.systemCategory('uncategorized').id;
    expect(j7).toMatchObject({
      transferStatus: 'suggested',
      transferPairId: payid.id,
      categoryId: uncategorized,
      categorySource: 'system',
      memberId: t.h.member('Home').id,
      memberSource: 'account',
    });
    expect(payid).toMatchObject({ transferStatus: 'suggested', transferPairId: j7.id });

    // ---------- cba ----------
    const cba = await importFixture('CBA Female', 'cba/female-2026-09.csv');
    expect(cba).toMatchObject({ rowCount: 20, insertedCount: 20, duplicateCount: 0 });
    checkRows(await listTransactions(t, 'CBA Female'), CBA);

    // R6.2：以前导入的 joint #11（****0003 重认出 CBA Female）和 CBA #10 配对，#10 改成 auto
    const [j11, c10] = [await J11(), await C10()];
    expect(j11.transferPairId).toBe(c10.id);
    expect(c10.transferPairId).toBe(j11.id);
    expect(c10).toMatchObject({
      transferStatus: 'auto',
      categoryId: t.h.systemCategory('internal_transfer').id,
      categorySource: 'system',
      memberId: t.h.member('Female').id,
      memberSource: 'account',
    });
    // CBA #4 → Saver，Saver 没导入，配不上
    expect((await txIn('CBA Female', '2026-09-24', 100000)).transferPairId).toBeNull();

    // R9：期初 10,000.00、期末 11,561.59，对账通过
    expect(cba).toMatchObject({
      openingBalanceCents: 1000000,
      closingBalanceCents: 1156159,
      reconciliation: { status: 'passed', differenceCents: 0 },
    });
    const batch = await batchRow(cba.batchId);
    expect(batch.reconciled).toBe(true);
    expect(batch.warnings).toMatchObject({
      balance: [],
      reconciliation: { status: 'passed', differenceCents: 0 },
    });
    expect(cba.uncategorizedCount).toBe(4); // #3、#12、#13、#15（#10 已经是转账）
    expect(cba.warnings.balance).toEqual([]);

    // me 时的建议不受影响
    expect((await J7()).transferStatus).toBe('suggested');
    await expectPairsConsistent();
  });

  it('joint → cba only (U4 setup): #11 and CBA #10 are paired, CBA #10 becomes auto', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('CBA Female', 'cba/female-2026-09.csv');
    const [j11, c10] = [await J11(), await C10()];
    expect(j11.transferPairId).toBe(c10.id);
    expect(c10).toMatchObject({ transferStatus: 'auto', transferPairId: j11.id });
    // #17 → ANZ Male 还没导入
    expect((await J17()).transferPairId).toBeNull();
    await expectPairsConsistent();
  });

  it('cba first, then joint: the newly imported joint #11 finds CBA #10', async () => {
    await importFixture('CBA Female', 'cba/female-2026-09.csv');
    expect((await C10()).transferStatus).toBe('none');
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const [j11, c10] = [await J11(), await C10()];
    expect(c10).toMatchObject({ transferStatus: 'auto', transferPairId: j11.id });
    await expectPairsConsistent();
  });

  it('R6.3: a rejected suggestion is not suggested again by the cba import', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    // F8 拒绝（还没做页面，直接改库）：两边 none，配对清空
    for (const tx of [await J7(), await PAYID()]) {
      await db
        .update(schema.transaction)
        .set({ transferStatus: 'none', transferPairId: null })
        .where(eq(schema.transaction.id, tx.id));
    }

    const cba = await importFixture('CBA Female', 'cba/female-2026-09.csv');
    expect(cba.transfers.suggestions).toEqual([]);
    expect(await J7()).toMatchObject({ transferStatus: 'none', transferPairId: null });
    expect(await PAYID()).toMatchObject({ transferStatus: 'none', transferPairId: null });
  });

  it('P10 then cba: the confirmed pending pairs with CBA #10 as usual', async () => {
    const p10 = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-14',
      amountCents: -50000,
      category: 'Entertainment & eat-out / Restaurants',
      member: 'Female',
      note: '给老婆',
    });
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('CBA Female', 'cba/female-2026-09.csv');

    const c10 = await C10();
    expect(await getTransaction(p10)).toMatchObject({
      transferStatus: 'auto',
      transferPairId: c10.id,
      note: '给老婆',
    });
    expect(c10).toMatchObject({ transferStatus: 'auto', transferPairId: p10 });
    await expectPairsConsistent();
  });

  it('R6.2: a counterpart with a manual category is paired but keeps its category', async () => {
    await importFixture('CBA Female', 'cba/female-2026-09.csv');
    const c10 = await C10();
    const restaurants = t.h.category('Entertainment & eat-out / Restaurants').id;
    await db
      .update(schema.transactionSplit)
      .set({ categoryId: restaurants, categorySource: 'manual' })
      .where(eq(schema.transactionSplit.transactionId, c10.id));

    const joint = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const j11 = await J11();
    expect(await C10()).toMatchObject({
      transferStatus: 'none',
      transferPairId: j11.id,
      categoryId: restaurants,
      categorySource: 'manual',
    });
    expect(joint.transfers.pairs).toEqual([
      { aId: j11.id, bId: c10.id, counterpartUpdate: null, manualCategoryKept: true },
    ]);
  });

  it('R1B.1 + R9: broken-balance.csv inserts 3 rows, 2 balance warnings, still reconciles', async () => {
    const result = await importFixture('CBA Female', 'cba/broken-balance.csv');
    expect(result).toMatchObject({
      insertedCount: 3,
      openingBalanceCents: 944925,
      closingBalanceCents: 1156159,
      reconciliation: { status: 'passed', differenceCents: 0 },
    });
    expect(result.warnings.balance).toHaveLength(2);
    expect((await batchRow(result.batchId)).reconciled).toBe(true);
  });

  it('R9: ANZ without balances → reconciled stays empty', async () => {
    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(result.reconciliation).toEqual({ status: 'none', differenceCents: null });
    expect((await batchRow(result.batchId)).reconciled).toBeNull();
  });

  it('R9: ANZ with balances → passed when they add up, failed with the difference otherwise', async () => {
    // joint-2026-09.csv 19 笔合计 +1,385.10
    const ok = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv', {
      openingBalanceCents: 100000,
      closingBalanceCents: 238510,
    });
    expect(ok.reconciliation).toEqual({ status: 'passed', differenceCents: 0 });
    expect((await batchRow(ok.batchId)).reconciled).toBe(true);

    await resetBusinessTables();
    t = await createTestHousehold();
    const off = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv', {
      openingBalanceCents: 100000,
      closingBalanceCents: 240000,
    });
    expect(off.reconciliation).toEqual({ status: 'failed', differenceCents: 1490 });
    const batch = await batchRow(off.batchId);
    expect(batch.reconciled).toBe(false);
    expect(batch.warnings).toMatchObject({
      reconciliation: { status: 'failed', differenceCents: 1490 },
    });
  });

  it('R9: uses the database, not only this file (overlap with balances counts the earlier rows)', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    // overlap 覆盖 09-25 到 10-08：数据库里这段有 09-25 到 09-30 的 6 笔（主文件）+ 3 笔新增
    // 合计：-15000 − 450×3 − 9840 + 500 − 500 + 200000 − 4510 = 169300
    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv', {
      openingBalanceCents: 0,
      closingBalanceCents: 169300,
    });
    expect(result.reconciliation).toEqual({ status: 'passed', differenceCents: 0 });
  });

  it('R8.4: P1 to P6 then joint → still-pending P3 to P6 are listed for checking', async () => {
    const pending = (date: string, amountCents: number) =>
      insertPending(t, {
        account: 'ANZ Joint',
        date,
        amountCents,
        category: 'Groceries / Supermarket',
        member: 'Home',
      });
    await pending('2026-09-20', -6120); // P1
    await pending('2026-09-20', -3875); // P2
    const P3 = await pending('2026-09-11', -2500);
    const P4 = await pending('2026-09-12', -2500);
    const P5 = await pending('2026-09-05', -1000);
    const P6 = await pending('2026-09-02', -5840);

    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    // date_to 09-30 − 3 天 = 09-27，四笔都早于它
    expect(result.pendingToCheck.map((p) => p.id)).toEqual([P6, P5, P3, P4]);
    expect(result.pendingToCheck[0]).toEqual({
      id: P6,
      date: '2026-09-02',
      amountCents: -5840,
      merchant: 'MANUAL ENTRY',
    });
    // 未分类只算本批次：17 笔新增里的 #7、#15、#16、#18；P1、P2 是用户分过类的
    expect(result.uncategorizedCount).toBe(4);
  });

  it('R8.4: a pending within 3 days of date_to is not listed', async () => {
    await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-28',
      amountCents: -1234,
      category: 'Groceries / Supermarket',
      member: 'Home',
    });
    const result = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(result.pendingToCheck).toEqual([]);
    // 别的家庭的数据不会被查到
    expect(
      await db.$count(
        schema.transaction,
        and(
          eq(schema.transaction.householdId, t.ctx.householdId),
          eq(schema.transaction.status, 'pending'),
        ),
      ),
    ).toBe(1);
  });
});
