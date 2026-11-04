// M8.5-5 CBA PDF 对账单导入（business-rules.md R1E、R4.1、R4.3、R6.1、R6.2、R9、R12、R12.1、R12.2）
// 期望值来自 fixtures/cases/13-cba-statement.md D1 到 D11 和 04-cba-female-2026-09.md 的 merchant
// fixture 的行直接交给 importStatementLines（R1E 第一层不改，PDF buffer 那条路 R1C、R1D 已经测过）
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getDashboard } from '@/server/dashboard';
import {
  importCsv,
  importStatementLines,
  undoImport,
  type ImportResult,
  type ImportSuccess,
} from '@/server/imports';
import {
  readAnzPlusStatementFixture,
  readCbaStatementFixture,
  readFixture,
  readStatementFixture,
  type FixturePath,
} from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { findNumbersInDatabase, listTransactions } from './helpers/transactions';

let t: DbTestHousehold;

const FEMALE = 'CBA Female';

function expectOk(result: ImportResult): ImportSuccess {
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result;
}

// 不选账户（R1E 自动认账户）
const importUnassigned = (name: `${string}.txt`) =>
  importStatementLines(t.ctx, { fileName: name, lines: readCbaStatementFixture(name) });

const importFemale = (name: `${string}.txt`) =>
  importStatementLines(t.ctx, {
    accountId: t.h.account(FEMALE).id,
    fileName: name,
    lines: readCbaStatementFixture(name),
  });

async function importCsvFixture(account: string, path: FixturePath) {
  return expectOk(
    await importCsv(t.ctx, {
      accountId: t.h.account(account).id,
      fileName: path,
      text: readFixture(path),
    }),
  );
}

async function batchRow(id: string) {
  const [row] = await db.select().from(schema.importBatch).where(eq(schema.importBatch.id, id));
  return row;
}

async function countRows() {
  return { batches: await db.$count(schema.importBatch), txs: await db.$count(schema.transaction) };
}

async function txIn(account: string, date: string, amountCents: number) {
  const rows = (await listTransactions(t, account)).filter(
    (r) => r.date === date && r.amountCents === amountCents,
  );
  expect(rows, `${account} ${date} ${amountCents}`).toHaveLength(1);
  return rows[0];
}

// 04-cba-female-2026-09.md 的 merchant，按 listTransactions 的顺序（日期新的在前、同一天金额大的在前）
// prettier-ignore
const MERCHANTS: [string, number, string][] = [
  ['2026-09-30', 1234, 'CREDIT INTEREST'],
  ['2026-09-28', -90000, 'BPAY TAX OFFICE PAYMENTS'],
  ['2026-09-25', 300000, 'FAST TRANSFER FROM ACME TRADING PTY LTD INVOICE 0925'],
  ['2026-09-24', 100000, 'TRANSFER FROM XX7777 HOME'],
  ['2026-09-22', -45560, 'BPAY DEFT PAYMENTS'],
  ['2026-09-20', 400, 'CBA YELLO HLPCKG CSHBK'],
  ['2026-09-19', 3860, 'DIRECT CREDIT 002221 MCARE BENEFITS ****6789 ABCD'],
  ['2026-09-16', 50000, 'FAST TRANSFER FROM TEST HOLDER JOINT'],
  ['2026-09-16', -6490, 'CROWN ASIAN SPENCER DOCKLANDS'],
  ['2026-09-16', -29840, 'DIRECT DEBIT 000793 BUPA AUSTRALIA ****4000'],
  ['2026-09-15', -2280, 'KIS HAIR MELBOURNE'],
  ['2026-09-12', -300, 'TOWER SUSHI & GOURM MELBOURNE'],
  ['2026-09-12', -300, 'TOWER SUSHI & GOURM MELBOURNE'],
  ['2026-09-10', -7500, 'LIGHTNING BROADBAND'],
  ['2026-09-08', 2250, 'FAST TRANSFER FROM OTHER FRIEND DINNER'],
  ['2026-09-08', -4500, 'TRANSFER TO TEST FRIEND EAT EAT'],
  ['2026-09-05', -680, 'OVERLAY COFFEE MELBOURNE'],
  ['2026-09-03', -7135, 'BPAY SEENE'],
  ['2026-09-02', -148000, 'LOAN REPAYMENT LN REPAY ****6789'],
  ['2026-09-01', 41000, 'SALARY EXAMPLE SCHOOL WAGES ****2026'],
];

// R2.3：交易描述、merchant、批次文件名里没有 8 位以上连续数字（id 是 uuid，不查）
async function findLongNumbers() {
  const txs = await db
    .select({ raw: schema.transaction.rawDescription, merchant: schema.transaction.merchant })
    .from(schema.transaction)
    .where(
      and(
        eq(schema.transaction.householdId, t.ctx.householdId),
        sql`(${schema.transaction.rawDescription} ~ '\\d{8,}' or ${schema.transaction.merchant} ~ '\\d{8,}')`,
      ),
    );
  const batches = await db
    .select({ fileName: schema.importBatch.fileName })
    .from(schema.importBatch)
    .where(sql`${schema.importBatch.fileName} ~ '\\d{8,}'`);
  return [...txs, ...batches];
}

describeDb('M8.5-5 CBA importStatement', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('D1 / R1E: no account given → CBA Female, 20 rows, closed period, reconciled', async () => {
    const result = expectOk(await importUnassigned('female-2026-09.txt'));
    expect(result).toMatchObject({
      rowCount: 20,
      insertedCount: 20,
      duplicateCount: 0,
      openingBalanceCents: 1000000,
      closingBalanceCents: 1156159,
      reconciliation: { status: 'passed', differenceCents: 0 },
    });
    expect(await batchRow(result.batchId)).toMatchObject({
      accountId: t.h.account(FEMALE).id,
      source: 'pdf',
      dateFrom: '2026-09-01', // R1E：闭区间，不加一天
      dateTo: '2026-09-30',
      openingBalanceCents: 1000000,
      closingBalanceCents: 1156159,
      reconciled: true,
    });

    const rows = await listTransactions(t, FEMALE);
    expect(rows.map((r) => [r.date, r.amountCents, r.merchant])).toEqual(MERCHANTS);
    expect(rows.every((r) => r.balanceCents !== null)).toBe(true);

    // R6.1：Transfer from xx7777 → CBA Female Saver，auto
    const saver = await txIn(FEMALE, '2026-09-24', 100000);
    expect(saver).toMatchObject({
      transferStatus: 'auto',
      categoryId: t.h.category('Internal transfer').id,
    });
    expect(result.transactions.find((x) => x.id === saver.id)).toMatchObject({
      transferAccountId: t.h.account('CBA Female Saver').id,
    });

    // R2.3、R1E：BSB、完整账号不入库，描述里没有 8 位以上连续数字
    expect(await findLongNumbers()).toEqual([]);
    expect(await findNumbersInDatabase(['10000003', '069999', '06 9999'])).toEqual([]);
  });

  it('D2 / R4.1: importing the same statement twice skips all 20', async () => {
    expectOk(await importUnassigned('female-2026-09.txt'));
    const second = expectOk(await importUnassigned('female-2026-09.txt'));
    expect(second).toMatchObject({ rowCount: 20, insertedCount: 0, duplicateCount: 20 });
    expect(await listTransactions(t, FEMALE)).toHaveLength(20);
  });

  it('D3 / R12.2: female-2026-10.txt (0 transactions) connects to the September statement', async () => {
    const first = expectOk(await importUnassigned('female-2026-09.txt'));
    const result = expectOk(await importFemale('female-2026-10.txt'));
    expect(result).toMatchObject({
      rowCount: 0,
      insertedCount: 0,
      reconciliation: { status: 'passed' },
      warnings: {
        statementContinuity: {
          status: 'connected',
          previous: { batchId: first.batchId, dateFrom: '2026-09-01', dateTo: '2026-09-30' },
        },
      },
    });
    expect(await batchRow(result.batchId)).toMatchObject({
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      reconciled: true,
    });
  });

  it('D4 / R1E / R12.2: year-rollover.txt adds 2, connects by balance despite the gap', async () => {
    const first = expectOk(await importUnassigned('female-2026-09.txt'));
    const result = expectOk(await importFemale('year-rollover.txt'));
    expect(result).toMatchObject({
      insertedCount: 2,
      reconciliation: { status: 'passed' },
      warnings: { statementContinuity: { status: 'connected', previous: { batchId: first.batchId } } },
    });
    expect(await batchRow(result.batchId)).toMatchObject({
      dateFrom: '2026-12-16',
      dateTo: '2027-01-15',
      reconciled: true,
    });
    const rows = await listTransactions(t, FEMALE);
    expect(rows.slice(0, 2).map((r) => [r.date, r.amountCents])).toEqual([
      ['2027-01-05', -7500],
      ['2026-12-20', 400],
    ]);
  });

  it('D5 / R4.2 / R4.3: CSV first, then the same month as PDF → nothing new, CSV rows untouched', async () => {
    const csv = await importCsvFixture(FEMALE, 'cba/female-2026-09.csv');
    const before = await listTransactions(t, FEMALE);
    expect(before).toHaveLength(20);

    const pdf = expectOk(await importFemale('female-2026-09.txt'));
    expect(pdf).toMatchObject({
      rowCount: 20,
      insertedCount: 0,
      duplicateCount: 20,
      reconciliation: { status: 'passed' },
    });
    // R12.2：没有上一份 PDF 批次，CSV 批次不算
    expect(pdf.warnings.statementContinuity ?? null).toBeNull();
    expect(await batchRow(pdf.batchId)).toMatchObject({
      source: 'pdf',
      duplicateCount: 20,
      reconciled: true,
    });

    const after = await listTransactions(t, FEMALE);
    expect(after).toEqual(before);
    expect(after.every((r) => r.importBatchId === csv.batchId)).toBe(true);
  });

  it('D6 / R4.3: PDF first, then CSV → CSV skips 17, adds the 3 BPAY again (known, not handled)', async () => {
    expectOk(await importFemale('female-2026-09.txt'));
    const csv = await importCsvFixture(FEMALE, 'cba/female-2026-09.csv');
    expect(csv).toMatchObject({
      insertedCount: 3,
      duplicateCount: 17,
      reconciliation: { status: 'failed', differenceCents: 142695 },
    });
    expect((await batchRow(csv.batchId)).reconciled).toBe(false);
    expect(await listTransactions(t, FEMALE)).toHaveLength(23);
  });

  it('D7 / R12.1: undoing the PDF batch after CSV deletes nothing, CSV rows untouched', async () => {
    await importCsvFixture(FEMALE, 'cba/female-2026-09.csv');
    const before = await listTransactions(t, FEMALE);
    const pdf = expectOk(await importFemale('female-2026-09.txt'));

    const undone = await undoImport(t.ctx, pdf.batchId);
    expect(undone).toMatchObject({ ok: true, deletedCount: 0, restoredPendingCount: 0 });
    expect(await listTransactions(t, FEMALE)).toEqual(before);
  });

  it('D8 / R1E: wrong-account.txt (…0002) does not go to ANZ Male, nothing written', async () => {
    const result = await importUnassigned('wrong-account.txt');
    expect(result).toMatchObject({
      ok: false,
      reason: 'parse',
      message: '找不到尾号是 0002 的 CBA 账户，先去账户设置填上尾号',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('D9 / R1E: archived CBA accounts are not candidates', async () => {
    await db
      .update(schema.financialAccount)
      .set({ isArchived: true })
      .where(eq(schema.financialAccount.id, t.h.account(FEMALE).id));
    const result = await importUnassigned('female-2026-09.txt');
    expect(result).toMatchObject({
      ok: false,
      message: '找不到尾号是 0003 的 CBA 账户，先去账户设置填上尾号',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('D10 / R1E: two CBA suffixes match → fails, nothing written', async () => {
    await db.insert(schema.financialAccount).values({
      householdId: t.ctx.householdId,
      name: 'CBA Female 2',
      bank: 'cba',
      type: 'everyday',
      defaultMemberId: t.h.member('Female').id,
      numberSuffix: '00003',
    });
    const result = await importUnassigned('female-2026-09.txt');
    expect(result).toMatchObject({
      ok: false,
      message: '有 2 个 CBA 账户的尾号都对得上，去账户设置把尾号填长一点',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('D11 / R1E: ANZ and ANZ Plus statements are still recognised after the three-way choice', async () => {
    const anz = expectOk(
      await importStatementLines(t.ctx, {
        fileName: 'joint-2026-09.txt',
        lines: readStatementFixture('joint-2026-09.txt'),
      }),
    );
    const plus = expectOk(
      await importStatementLines(t.ctx, {
        fileName: 'growth-2026-09.txt',
        lines: readAnzPlusStatementFixture('growth-2026-09.txt'),
      }),
    );
    expect((await batchRow(anz.batchId)).accountId).toBe(t.h.account('ANZ Joint').id);
    expect((await batchRow(plus.batchId)).accountId).toBe(t.h.account('ANZ Plus Male').id);
  });

  it('R1E: a statement that looks like none of the three → fails, nothing written', async () => {
    const result = await importStatementLines(t.ctx, {
      fileName: 'hello.txt',
      lines: [{ page: 1, text: 'Hello' }],
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'parse',
      message: '认不出这份对账单，只支持 ANZ、ANZ Plus、CBA 的 PDF 对账单',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('R1: cash accounts still cannot import a PDF statement', async () => {
    const [cash] = await db
      .insert(schema.financialAccount)
      .values({
        householdId: t.ctx.householdId,
        name: 'Cash',
        bank: 'cash',
        type: 'cash',
        defaultMemberId: t.h.member('Home').id,
      })
      .returning({ id: schema.financialAccount.id });
    const result = await importStatementLines(t.ctx, {
      accountId: cash.id,
      fileName: 'female-2026-09.txt',
      lines: readCbaStatementFixture('female-2026-09.txt'),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'not_importable',
      message: '只有 ANZ、ANZ Plus 和 CBA 账户能导入 PDF 对账单',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  // 和 ANZ joint 之间的转账：joint #11（09-15 −500）和 CBA 09-16 +500 配对（R6.2），两个顺序一样
  async function expectPairedWithJoint() {
    const j11 = await txIn('ANZ Joint', '2026-09-15', -50000);
    const c10 = await txIn(FEMALE, '2026-09-16', 50000);
    expect(j11).toMatchObject({ transferPairId: c10.id });
    expect(c10).toMatchObject({ transferStatus: 'auto', transferPairId: j11.id });
  }

  async function dashboardTotals() {
    const d = await getDashboard(
      t.ctx,
      { period: { start: '2026-09-01', end: '2026-09-30' } },
      '2026-10-30',
    );
    const { incomeCents, preTaxIncomeCents, expenseCents, uncategorized } = d.current;
    return { incomeCents, preTaxIncomeCents, expenseCents, uncategorized };
  }

  it('R6.2: joint CSV, then CBA PDF → the transfer pairs; dashboard same as with the CBA CSV', async () => {
    await importCsvFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importCsvFixture(FEMALE, 'cba/female-2026-09.csv');
    await expectPairedWithJoint();
    const withCsv = await dashboardTotals();

    await resetBusinessTables();
    t = await createTestHousehold();
    await importCsvFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expectOk(await importFemale('female-2026-09.txt'));
    await expectPairedWithJoint();
    expect(await dashboardTotals()).toEqual(withCsv);
  });

  it('R6.2: CBA PDF first, then joint CSV → the transfer pairs too', async () => {
    expectOk(await importFemale('female-2026-09.txt'));
    expect((await txIn(FEMALE, '2026-09-16', 50000)).transferStatus).toBe('none');
    await importCsvFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await expectPairedWithJoint();
  });
});
