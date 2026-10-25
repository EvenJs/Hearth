// M4-2 流水查询（prd.md F8、business-rules.md R10.1、R16.5）
// 期望值来自 docs/tasks/m4.md M4-2 完成标准和 fixtures/README.md（joint、me、拆分用例）
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getImportResult, importCsv } from '@/server/imports';
import { countQuickFilters, getTransaction, listTransactions } from '@/server/transactions';
import type { TransactionFilters } from '@/lib/transactions/filters';
import type { HouseholdContext } from '@/server/context';
import { readFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

// 固定"今天"，"今年"= 2026-01-01 到 2026-10-24
const TODAY = '2026-10-24';

let t: DbTestHousehold;

// 返回导入批次 id
async function importFixture(account: string, path: FixturePath): Promise<string> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account(account).id,
    fileName: path,
    text: readFixture(path),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result.batchId;
}

const list = (filters: TransactionFilters, page?: number, pageSize?: number) =>
  listTransactions(t.ctx, filters, { today: TODAY, page, pageSize });

const merchants = (r: Awaited<ReturnType<typeof list>>) => r.items.map((i) => i.merchant);

async function txIdByMerchant(merchant: string): Promise<string> {
  const rows = await db
    .select({ id: schema.transaction.id })
    .from(schema.transaction)
    .where(
      and(
        eq(schema.transaction.householdId, t.ctx.householdId),
        eq(schema.transaction.merchant, merchant),
      ),
    );
  if (rows.length !== 1) throw new Error(`${merchant} 有 ${rows.length} 笔`);
  return rows[0].id;
}

// fixtures/README.md "拆分（R15）"：#19 主拆分 -3540，再加 -1500 Household supplies、-800 Cosmetics（Male card）
// M4-6 才有拆分的数据层，这里直接写库
async function splitColes(): Promise<string> {
  const id = await txIdByMerchant('COLES 0559 MELBOURNE');
  const { ctx, h } = t;
  await db.transaction(async (tx) => {
    await tx
      .update(schema.transactionSplit)
      .set({ amountCents: -3540 })
      .where(
        and(
          eq(schema.transactionSplit.transactionId, id),
          eq(schema.transactionSplit.isPrimary, true),
        ),
      );
    await tx.insert(schema.transactionSplit).values([
      {
        householdId: ctx.householdId,
        transactionId: id,
        amountCents: -1500,
        categoryId: h.category('Home & utilities / Household supplies').id,
        memberId: h.member('Home').id,
        categorySource: 'manual',
        memberSource: 'category',
        isPrimary: false,
        isPreTax: false,
      },
      {
        householdId: ctx.householdId,
        transactionId: id,
        amountCents: -800,
        categoryId: h.category('Personal & medical / Cosmetics & toiletries').id,
        memberId: h.member('Male').id,
        categorySource: 'manual',
        memberSource: 'card',
        isPrimary: false,
        isPreTax: false,
      },
    ]);
  });
  return id;
}

describeDb('M4-2 listTransactions / getTransaction', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  // ---------- 完成标准 ----------

  it('joint: this year + merchant contains COLES → 1 row, total -58.40', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const r = await list({ period: 'this_year', merchant: 'COLES' });
    expect(r.count).toBe(1);
    expect(r.totalCents).toBe(-5840);
    expect(merchants(r)).toEqual(['COLES 0559 MELBOURNE']);
  });

  it('joint: uncategorised quick filter → 4 rows (#7, #15, #16, #18)', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const r = await list({ quick: 'uncategorized' });
    expect(r.count).toBe(4);
    expect(merchants(r)).toEqual([
      'PAYID DEPOSIT REF DINNER SPLIT', // #7  09-22
      'UNKNOWN SHOP PTY LTD MELBOURNE', // #15 09-08
      'EASI AU ****2605', // #16 09-05
      'TRANSFER FROM ****9999', // #18 09-02
    ]);
    expect(r.totalCents).toBe(8000 - 1200 - 2715 + 30000);
  });

  it('joint + me: suggested transfer quick filter → 2 rows', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    const r = await list({ quick: 'suggested' });
    expect(r.count).toBe(2);
    expect(r.items.map((i) => [i.account.name, i.amountCents, i.transferStatus])).toEqual([
      ['ANZ Joint', 8000, 'suggested'], // 09-22
      ['ANZ Male', -8000, 'suggested'], // 09-21
    ]);
    expect(r.items[0].transferPairId).toBe(r.items[1].id);
    expect(r.totalCents).toBe(0);
  });

  it('R16.5: after the split case, filtering Groceries / Supermarket counts only -35.40 of #19', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const colesId = await splitColes();
    const supermarket = t.h.category('Groceries / Supermarket').id;

    const coles = await list({ categoryId: supermarket, merchant: 'COLES' });
    expect(coles.count).toBe(1);
    expect(coles.totalCents).toBe(-3540);
    // 列表里仍是整笔交易，带所有拆分
    expect(coles.items[0].id).toBe(colesId);
    expect(coles.items[0].amountCents).toBe(-5840);
    expect(coles.items[0].splits.map((s) => [s.isPrimary, s.amountCents, s.member.name])).toEqual([
      [true, -3540, 'Home'],
      [false, -1500, 'Home'],
      [false, -800, 'Male'],
    ]);

    // fixtures/README.md 拆分后 9 月统计：Groceries / Supermarket 13495
    const all = await list({ categoryId: supermarket });
    expect(all.count).toBe(4); // #9、#13、#14、#19
    expect(all.totalCents).toBe(-13495);
  });

  it('every query is scoped to household_id: another household sees nothing', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const [other] = await db
      .insert(schema.household)
      .values({ name: 'Other Household' })
      .returning({ id: schema.household.id });
    const otherCtx: HouseholdContext = { ...t.ctx, householdId: other.id, memberId: null };

    const r = await listTransactions(otherCtx, {}, { today: TODAY });
    expect(r).toMatchObject({ items: [], count: 0, totalCents: 0 });
    // 用本家庭的分类 id、账户 id 筛选也查不到
    const r2 = await listTransactions(
      otherCtx,
      {
        accountId: t.h.account('ANZ Joint').id,
        categoryId: t.h.category('Groceries / Supermarket').id,
      },
      { today: TODAY },
    );
    expect(r2.count).toBe(0);

    const colesId = await txIdByMerchant('COLES 0559 MELBOURNE');
    expect(await getTransaction(otherCtx, colesId)).toBeNull();
    expect(await getTransaction(t.ctx, colesId)).not.toBeNull();
  });

  // ---------- 其他筛选条件 ----------

  it('no filters: all 19 joint rows, date descending, total = sum of amounts', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const r = await list({});
    expect(r.count).toBe(19);
    expect(r.items).toHaveLength(19);
    const dates = r.items.map((i) => i.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(r.totalCents).toBe(r.items.reduce((s, i) => s + i.amountCents, 0));
    expect(r.items.every((i) => i.splits.length === 1 && i.splits[0].isPrimary)).toBe(true);
  });

  it('pagination: count and total cover all pages', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const all = await list({});
    const pages = await Promise.all([1, 2, 3, 4].map((p) => list({}, p, 5)));
    expect(pages.map((p) => p.items.length)).toEqual([5, 5, 5, 4]);
    expect(pages.flatMap((p) => p.items.map((i) => i.id))).toEqual(all.items.map((i) => i.id));
    expect(pages.every((p) => p.count === 19 && p.totalCents === all.totalCents)).toBe(true);
  });

  it('period: last month (September) has all rows, this month (October) has none', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect((await list({ period: 'last_month' })).count).toBe(19);
    expect((await list({ period: 'this_month' })).count).toBe(0);
    expect(
      (await list({ period: { start: '2026-09-10', end: '2026-09-12' } })).items.map((i) => i.date),
    ).toEqual(['2026-09-12', '2026-09-10', '2026-09-10']);
  });

  it('category: a top-level category includes all its second-level ones', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const r = await list({ categoryId: t.h.category('Groceries').id });
    expect(r.count).toBe(4); // #9、#13、#14、#19，都是 Supermarket
    expect(r.totalCents).toBe(-3875 + 150 - 6230 - 5840);
  });

  it('R16.5: type expense includes MEDICARE BENEFIT +45.80 and Bank fees / Cash withdrawal', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const r = await list({ type: 'expense' });
    expect(merchants(r)).toContain('MEDICARE BENEFIT');
    expect(merchants(r)).toContain('ACCOUNT SERVICING FEE');
    expect(merchants(r)).toContain('ATM CBA HAWTHORN');
    expect(merchants(r)).not.toContain('PAYID DEPOSIT REF DINNER SPLIT');
    // fixtures/README.md 9 月支出 45575 分（支出 = −Σ 金额）
    expect(r.totalCents).toBe(-45575);

    const transfers = await list({ type: 'internal_transfer' });
    expect(transfers.items.map((i) => i.amountCents)).toEqual([-50000, 200000]); // #11、#17
  });

  it('member filter uses the split member (#9 paid with Female card is Home)', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const female = await list({ memberId: t.h.member('Female').id });
    expect(merchants(female)).toEqual(['EASI AU ****2605']); // #16 only
    const male = await list({ memberId: t.h.member('Male').id });
    expect(male.count).toBe(2); // #4、#5 Bubble tea
    expect(male.totalCents).toBe(-900);
  });

  it('amount range uses the absolute transaction amount, inclusive', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    // |金额| ≥ 50.00：#3、#6、#7、#8、#11、#14、#17、#18、#19
    expect((await list({ minCents: 5000 })).count).toBe(9);
    // 4.50 到 25.00，含两端：#1（+5.00 退回）、#2、#4、#5、#12、#15
    const r = await list({ minCents: 450, maxCents: 2500 });
    expect(r.items.map((i) => i.amountCents).sort((a, b) => a - b)).toEqual([
      -2500, -1200, -500, -450, -450, 500,
    ]);
  });

  it('merchant keyword is case-insensitive and % _ are literal', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect((await list({ merchant: 'melb asian' })).count).toBe(2);
    expect((await list({ merchant: '%' })).count).toBe(0);
    expect((await list({ merchant: '_' })).count).toBe(0);
  });

  it('status and pre-tax filters', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect((await list({ status: 'confirmed' })).count).toBe(19);
    expect((await list({ status: 'pending' })).count).toBe(0);
    expect((await list({ isPreTax: true })).count).toBe(0);
    expect((await list({ isPreTax: false })).count).toBe(19);
  });

  // ---------- 详情 ----------

  it('batch filter (M4-7): only that import; uncategorized count matches the import result', async () => {
    const jointBatch = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const meBatch = await importFixture('ANZ Male', 'anz/me-2026-09.csv');

    expect((await list({ batchId: jointBatch })).count).toBe(19);
    expect((await list({ batchId: meBatch })).count).toBe(4);

    // joint #7、#15、#16、#18；me 的 PAYID PAYMENT（suggested 仍算未分类）
    const jointResult = await getImportResult(t.ctx, jointBatch);
    const meResult = await getImportResult(t.ctx, meBatch);
    const jointUncat = await list({ batchId: jointBatch, quick: 'uncategorized' });
    const meUncat = await list({ batchId: meBatch, quick: 'uncategorized' });
    expect(jointUncat.count).toBe(4);
    expect(jointUncat.count).toBe(jointResult?.uncategorizedCount);
    expect(meUncat.count).toBe(1);
    expect(meUncat.count).toBe(meResult?.uncategorizedCount);
  });

  // ---------- 快捷条件的笔数 ----------

  it('countQuickFilters: joint → 4 uncategorized, 0 suggested', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(await countQuickFilters(t.ctx)).toEqual({ uncategorized: 4, suggested: 0 });
  });

  it('countQuickFilters: joint + me → 5 uncategorized, 2 suggested; other household sees 0', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    expect(await countQuickFilters(t.ctx)).toEqual({ uncategorized: 5, suggested: 2 });

    const [other] = await db
      .insert(schema.household)
      .values({ name: 'Other Household' })
      .returning({ id: schema.household.id });
    const otherCtx: HouseholdContext = { ...t.ctx, householdId: other.id, memberId: null };
    expect(await countQuickFilters(otherCtx)).toEqual({ uncategorized: 0, suggested: 0 });
  });

  // ---------- 详情 ----------

  it('getTransaction: all splits, import file name, and the paired other half', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    const id = await txIdByMerchant('TRANSFER FROM ****0002'); // joint #17
    const d = await getTransaction(t.ctx, id);
    expect(d).toMatchObject({
      date: '2026-09-03',
      amountCents: 200000,
      transferStatus: 'auto',
      account: { name: 'ANZ Joint' },
      importBatch: { fileName: 'anz/joint-2026-09.csv' },
      pair: { date: '2026-09-03', amountCents: -200000, account: { name: 'ANZ Male' } },
    });
    expect(d!.splits).toHaveLength(1);
    expect(d!.splits[0].category).toMatchObject({
      nameEn: 'Internal transfer',
      systemKey: 'internal_transfer',
      parent: null,
    });
  });

  it('getTransaction: split categories carry their parent; no pair → null', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const id = await splitColes();
    const d = await getTransaction(t.ctx, id);
    expect(d!.pair).toBeNull();
    expect(d!.splits.map((s) => `${s.category.parent?.nameEn} / ${s.category.nameEn}`)).toEqual([
      'Groceries / Supermarket',
      'Home & utilities / Household supplies',
      'Personal & medical / Cosmetics & toiletries',
    ]);
  });

  it('getTransaction: unknown or malformed id → null', async () => {
    expect(await getTransaction(t.ctx, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await getTransaction(t.ctx, 'not-a-uuid')).toBeNull();
  });
});
