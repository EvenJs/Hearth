// M7.5-5 ANZ Plus PDF 对账单导入（business-rules.md R1D、R4.1、R6.1、R6.2、R8.2、R9、R12、R12.1、R12.2）
// 期望值来自 fixtures/cases/10-anz-plus-statement.md B1 到 B10 和 fixtures/cases/06-pending.md P11
// 大部分用例把 fixture 的行直接交给 importStatementLines；B1 另外走一遍 importStatement（PDF buffer）
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getDashboard } from '@/server/dashboard';
import {
  identifyStatement,
  importCsv,
  importStatement,
  importStatementLines,
  undoImport,
  type ImportResult,
  type ImportSuccess,
} from '@/server/imports';
import { readAnzPlusStatementFixture, readFixture } from '../helpers/fixtures';
import { makePdf } from '../helpers/pdf';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import {
  findNumbersInDatabase,
  getTransaction,
  insertPending,
  listTransactions,
} from './helpers/transactions';

let t: DbTestHousehold;

const PLUS = 'ANZ Plus Male';
const MALE = 'ANZ Male';

function expectOk(result: ImportResult): ImportSuccess {
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result;
}

// 不选账户（R1D 自动认账户）
const importUnassigned = (name: `${string}.txt`) =>
  importStatementLines(t.ctx, { fileName: name, lines: readAnzPlusStatementFixture(name) });

const importPlus = (name: `${string}.txt`) =>
  importStatementLines(t.ctx, {
    accountId: t.h.account(PLUS).id,
    fileName: name,
    lines: readAnzPlusStatementFixture(name),
  });

async function importMeToPlusCsv() {
  return expectOk(
    await importCsv(t.ctx, {
      accountId: t.h.account(MALE).id,
      fileName: 'me-to-plus-2026-09.csv',
      text: readFixture('anz/me-to-plus-2026-09.csv'),
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

// 用来测 importStatement 读 PDF 的那条路。从页面顶部往下排
// 每行按两个以上空格切成几块、分开放（真实对账单每一栏是一块）：一整块里的两个空格 PDF.js 读出来只剩一个，
// R1D 汇总那行要按两个空格分 4 段（R1C 不靠两个空格分段，所以 imports-statement 那边一行一块就行）
// Helvetica 10pt 一个字符最宽约 7pt，块之间再空 30pt，layoutLines 会拼回两个空格
function statementPdf(name: `${string}.txt`): Uint8Array {
  const byPage = new Map<number, string[]>();
  for (const l of readAnzPlusStatementFixture(name)) {
    byPage.set(l.page, [...(byPage.get(l.page) ?? []), l.text]);
  }
  return makePdf(
    [...byPage.values()].map((lines) =>
      lines.flatMap((line, i) => {
        let x = 20;
        return line
          .trim()
          .split(/\s{2,}/)
          .map((text) => {
            const block = { x, y: 820 - i * 14, text };
            x += text.length * 7 + 30;
            return block;
          });
      }),
    ),
  );
}

// P11：R8.1 改之前在 ANZ Plus 手动记的利息，直接写进数据库模拟旧数据
async function insertLegacyConfirmedInterest(date: string, amountCents: number) {
  const id = await insertPending(t, {
    account: PLUS,
    date,
    amountCents,
    category: 'Income / Interest',
    member: 'Male',
  });
  await db
    .update(schema.transaction)
    .set({ status: 'confirmed' })
    .where(eq(schema.transaction.id, id));
  return id;
}

describeDb('M7.5-5 ANZ Plus importStatement', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('B1 / R1D: no account given → ANZ Plus Male, 4 rows, period and balances from the summary', async () => {
    const result = expectOk(await importUnassigned('growth-2026-09.txt'));
    expect(result).toMatchObject({
      rowCount: 4,
      insertedCount: 4,
      duplicateCount: 0,
      matchedPendingCount: 0,
      openingBalanceCents: 1000000,
      closingBalanceCents: 1072500,
      reconciliation: { status: 'passed', differenceCents: 0 },
    });
    expect(await batchRow(result.batchId)).toMatchObject({
      accountId: t.h.account(PLUS).id,
      source: 'pdf',
      dateFrom: '2026-09-01', // R1D：不加一天
      dateTo: '2026-09-30',
      openingBalanceCents: 1000000,
      closingBalanceCents: 1072500,
    });

    const rows = await listTransactions(t, PLUS);
    expect(
      rows.map((r) => [r.date, r.amountCents, r.rawDescription, r.balanceCents, r.status]),
    ).toEqual([
      ['2026-09-30', 2000, 'BONUS CREDIT INTEREST PAID', 1072500, 'confirmed'],
      ['2026-09-30', 500, 'CREDIT INTEREST PAID', 1070500, 'confirmed'],
      ['2026-09-15', -30000, 'TRANSFER TO 012345-****0002 #100002', 1070000, 'confirmed'],
      ['2026-09-02', 100000, 'TRANSFER FROM 012345-****0002 #100001', 1100000, 'confirmed'],
    ]);
    // R6.1：对方是 ANZ Male（尾号 0002）。ANZ Male 还没导入，配不上，但已经是 auto
    expect(rows.filter((r) => r.transferStatus === 'auto')).toHaveLength(2);
    // R2.3：BSB、完整账号没有入库
    expect(await findNumbersInDatabase(['400000002', '400000004', '012345400'])).toEqual([]);
  });

  it('B1 / R1D: the same file through importStatement (PDF buffer) gives the same result', async () => {
    const result = expectOk(
      await importStatement(t.ctx, {
        fileName: 'growth-2026-09.pdf',
        buffer: statementPdf('growth-2026-09.txt'),
      }),
    );
    expect(result).toMatchObject({ insertedCount: 4, reconciliation: { status: 'passed' } });
    expect((await batchRow(result.batchId)).accountId).toBe(t.h.account(PLUS).id);
  });

  it('R1D: identifyStatement finds ANZ Plus Male and writes nothing', async () => {
    const r = await identifyStatement(t.ctx, {
      fileName: 'growth-2026-09.pdf',
      buffer: statementPdf('growth-2026-09.txt'),
    });
    expect(r).toMatchObject({ ok: true, account: { id: t.h.account(PLUS).id } });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('B2 / R4.1: importing the same statement twice skips all 4', async () => {
    expectOk(await importPlus('growth-2026-09.txt'));
    const second = expectOk(await importPlus('growth-2026-09.txt'));
    expect(second).toMatchObject({ rowCount: 4, insertedCount: 0, duplicateCount: 4 });
    expect(await listTransactions(t, PLUS)).toHaveLength(4);
  });

  it('B3 / R12.2: growth-2026-10.txt (0 transactions) connects to the September statement', async () => {
    const first = expectOk(await importPlus('growth-2026-09.txt'));
    const result = expectOk(await importPlus('growth-2026-10.txt'));
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
    });
  });

  it('B4 / R1D: wrong-account.txt (…0002) does not go to ANZ Male, nothing written', async () => {
    const result = await importUnassigned('wrong-account.txt');
    expect(result).toMatchObject({
      ok: false,
      reason: 'parse',
      message: '找不到尾号是 0002 的 ANZ Plus 账户，先去账户设置填上尾号',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('B5 / R1D: archived ANZ Plus accounts are not candidates', async () => {
    await db
      .update(schema.financialAccount)
      .set({ isArchived: true })
      .where(eq(schema.financialAccount.id, t.h.account(PLUS).id));
    const result = await importUnassigned('growth-2026-09.txt');
    expect(result).toMatchObject({
      ok: false,
      message: '找不到尾号是 0004 的 ANZ Plus 账户，先去账户设置填上尾号',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('B6 / R1D: two ANZ Plus suffixes match → fails, nothing written', async () => {
    await db.insert(schema.financialAccount).values({
      householdId: t.ctx.householdId,
      name: 'ANZ Plus Male 2',
      bank: 'anz_plus',
      type: 'savings',
      defaultMemberId: t.h.member('Male').id,
      numberSuffix: '00004',
    });
    const result = await importUnassigned('growth-2026-09.txt');
    expect(result).toMatchObject({
      ok: false,
      message: '有 2 个 ANZ Plus 账户的尾号都对得上，去账户设置把尾号填长一点',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('B7 / R1D: a CSV for ANZ Plus Male is rejected with a clear message', async () => {
    const result = await importCsv(t.ctx, {
      accountId: t.h.account(PLUS).id,
      fileName: 'joint.csv',
      text: readFixture('anz/joint-2026-09.csv'),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'not_importable',
      message: 'ANZ Plus 只能导 PDF 对账单',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('R1: an ANZ Plus statement on an ANZ account fails (parser follows the account bank)', async () => {
    const result = await importStatementLines(t.ctx, {
      accountId: t.h.account(MALE).id,
      fileName: 'growth-2026-09.txt',
      lines: readAnzPlusStatementFixture('growth-2026-09.txt'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'parse' });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('B8 / R8.2: a pending manual interest is confirmed, not duplicated', async () => {
    const pendingId = await insertPending(t, {
      account: PLUS,
      date: '2026-09-29',
      amountCents: 500,
      category: 'Income / Interest',
      member: 'Male',
    });
    const result = expectOk(await importPlus('growth-2026-09.txt'));
    expect(result).toMatchObject({ insertedCount: 3, matchedPendingCount: 1 });

    expect(await getTransaction(pendingId)).toMatchObject({
      status: 'confirmed',
      date: '2026-09-30',
      rawDescription: 'CREDIT INTEREST PAID',
      importBatchId: result.batchId,
    });
    const rows = await listTransactions(t, PLUS);
    expect(rows).toHaveLength(4);
    const confirmed = rows.find((r) => r.id === pendingId)!;
    expect(confirmed).toMatchObject({
      categoryId: t.h.category('Income / Interest').id,
      categorySource: 'manual',
    });
  });

  it('P11 / R8.2 / R12.1: a legacy confirmed manual interest is replaced; undo makes it pending; re-import matches again', async () => {
    const legacyId = await insertLegacyConfirmedInterest('2026-09-30', 2000);

    const first = expectOk(await importPlus('growth-2026-09.txt'));
    expect(first).toMatchObject({ insertedCount: 3, matchedPendingCount: 1 });
    expect(await getTransaction(legacyId)).toMatchObject({
      status: 'confirmed',
      rawDescription: 'BONUS CREDIT INTEREST PAID',
      importBatchId: first.batchId,
    });
    expect(await listTransactions(t, PLUS)).toHaveLength(4);
    expect((await listTransactions(t, PLUS)).find((r) => r.id === legacyId)).toMatchObject({
      categoryId: t.h.category('Income / Interest').id,
      categorySource: 'manual',
    });

    // R12.1：只删新增的 3 笔，被替换的旧利息变成 pending
    const undone = await undoImport(t.ctx, first.batchId);
    expect(undone).toMatchObject({ ok: true, deletedCount: 3, restoredPendingCount: 1 });
    expect(await getTransaction(legacyId)).toMatchObject({
      status: 'pending',
      importBatchId: null,
      dedupeKey: null,
    });
    expect(await listTransactions(t, PLUS)).toHaveLength(1);

    const second = expectOk(await importPlus('growth-2026-09.txt'));
    expect(second).toMatchObject({ insertedCount: 3, matchedPendingCount: 1 });
    expect(await getTransaction(legacyId)).toMatchObject({
      status: 'confirmed',
      importBatchId: second.batchId,
    });
  });

  it('P13 / R8.2: a confirmed manual tx on an ANZ account is not a candidate', async () => {
    const id = await insertPending(t, {
      account: MALE,
      date: '2026-09-02',
      amountCents: -100000,
      category: 'Income / Interest',
      member: 'Male',
    });
    await db
      .update(schema.transaction)
      .set({ status: 'confirmed' })
      .where(eq(schema.transaction.id, id));
    const result = await importMeToPlusCsv();
    expect(result).toMatchObject({ insertedCount: 2, matchedPendingCount: 0 });
    expect(await getTransaction(id)).toMatchObject({ status: 'confirmed', importBatchId: null });
  });

  // B9、B10：两个顺序结果一样
  async function expectPairedWithAnzMale() {
    const plus = await listTransactions(t, PLUS);
    const male = await listTransactions(t, MALE);
    const find = (rows: typeof plus, date: string, amountCents: number) => {
      const r = rows.find((x) => x.date === date && x.amountCents === amountCents);
      if (!r) throw new Error(`找不到 ${date} ${amountCents}`);
      return r;
    };
    const pairs = [
      [find(male, '2026-09-02', -100000), find(plus, '2026-09-02', 100000)],
      [find(male, '2026-09-15', 30000), find(plus, '2026-09-15', -30000)],
    ];
    for (const [a, b] of pairs) {
      expect(a.transferStatus).toBe('auto');
      expect(b.transferStatus).toBe('auto');
      expect(a.transferPairId).toBe(b.id);
      expect(b.transferPairId).toBe(a.id);
    }

    // 看板：转账不计收支，只剩利息
    const d = await getDashboard(
      t.ctx,
      { period: { start: '2026-09-01', end: '2026-09-30' } },
      '2026-10-30',
    );
    expect(d.current.incomeCents).toBe(2500);
    expect(d.current.expenseCents).toBe(0);
  }

  it('B9 / R6.2: ANZ first, then ANZ Plus → both transfers paired', async () => {
    await importMeToPlusCsv();
    expectOk(await importPlus('growth-2026-09.txt'));
    await expectPairedWithAnzMale();
  });

  it('B10 / R6.2: ANZ Plus first, then ANZ → same result', async () => {
    expectOk(await importPlus('growth-2026-09.txt'));
    await importMeToPlusCsv();
    await expectPairedWithAnzMale();
    // R2.3：ANZ 那边的 BSB + 完整账号也脱敏了
    expect(await findNumbersInDatabase(['400000002', '400000004', '012345400'])).toEqual([]);
  });
});
