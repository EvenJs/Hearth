// M6.6-4 ANZ PDF 对账单导入（business-rules.md R1C、R9、R12、R12.1、R12.2 首尾衔接、R8）
// 期望值来自 fixtures/README.md "ANZ 对账单用例" S1 到 S7 和 "期望结果：joint-2026-09.csv"
// 大部分用例把 fixture 的行直接交给 importStatementLines；S1 另外走一遍 importStatement（PDF buffer）
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import {
  importCsv,
  importStatement,
  getImportResult,
  identifyStatement,
  importStatementLines,
  listImportHistory,
  undoImport,
  type ImportResult,
  type ImportSuccess,
} from '@/server/imports';
import {
  readFixture,
  readStatementFixture,
  toStatementLines,
  type FixturePath,
} from '../helpers/fixtures';
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
  type TxRow,
} from './helpers/transactions';

let t: DbTestHousehold;

const JOINT = 'ANZ Joint';

function expectOk(result: ImportResult): ImportSuccess {
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result;
}

async function importStatementFixture(name: `${string}.txt`, account = JOINT) {
  return importStatementLines(t.ctx, {
    accountId: t.h.account(account).id,
    fileName: name,
    lines: readStatementFixture(name),
  });
}

async function importCsvFixture(path: FixturePath, text = readFixture(path)) {
  return expectOk(
    await importCsv(t.ctx, { accountId: t.h.account(JOINT).id, fileName: path, text }),
  );
}

async function batchRow(id: string) {
  const [row] = await db.select().from(schema.importBatch).where(eq(schema.importBatch.id, id));
  return row;
}

async function countRows() {
  const batches = await db.$count(schema.importBatch);
  const txs = await db.$count(schema.transaction);
  return { batches, txs };
}

// 分类、归属人按名字比：S1 要清空数据库重建测试家庭，uuid 每次都不一样
function categoryName(id: string): string {
  const c = t.h.categories.find((x) => x.id === id);
  if (!c) throw new Error(`找不到分类 ${id}`);
  const parent = c.parentId ? t.h.categories.find((x) => x.id === c.parentId) : undefined;
  return parent ? `${parent.nameEn} / ${c.nameEn}` : c.nameEn;
}
function memberName(id: string): string {
  const m = t.h.members.find((x) => x.id === id);
  if (!m) throw new Error(`找不到归属人 ${id}`);
  return m.name;
}

// 和 CSV 导入比较的字段：结果应该完全一样（fixtures/README 主表）
// dedupeKey 带 account_id，跨家庭比不了；key 一样由 S2（全部跳过）证明
const comparable = (r: TxRow) => ({
  date: r.date,
  amountCents: r.amountCents,
  merchant: r.merchant, // rawDescription 的空格多少可能不一样，R4 的 key 会合并空白
  cardLast4: r.cardLast4,
  balanceCents: r.balanceCents,
  status: r.status,
  source: r.source,
  transferStatus: r.transferStatus,
  splitCount: r.splitCount,
  category: categoryName(r.categoryId),
  categorySource: r.categorySource,
  isPreTax: r.isPreTax,
  member: memberName(r.memberId),
  memberSource: r.memberSource,
});

const sortKey = (r: ReturnType<typeof comparable>) =>
  `${r.date}|${r.amountCents}|${r.merchant}|${r.cardLast4}`;
const sorted = (rows: TxRow[]) =>
  rows.map(comparable).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

// 一行一块文字，从页面顶部往下排。用来测 importStatement 读 PDF 的那条路
function statementPdf(name: `${string}.txt`): Uint8Array {
  const byPage = new Map<number, string[]>();
  for (const l of readStatementFixture(name)) {
    byPage.set(l.page, [...(byPage.get(l.page) ?? []), l.text]);
  }
  return makePdf(
    [...byPage.values()].map((lines) => lines.map((text, i) => ({ x: 20, y: 820 - i * 14, text }))),
  );
}

describeDb('M6.6-4 importStatement', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('S1 / R1C: joint-2026-09.txt on an empty database gives the same 19 rows as the CSV', async () => {
    const result = expectOk(await importStatementFixture('joint-2026-09.txt'));
    expect(result).toMatchObject({
      rowCount: 19,
      insertedCount: 19,
      duplicateCount: 0,
      matchedPendingCount: 0,
      openingBalanceCents: 500000,
      closingBalanceCents: 638510,
      reconciliation: { status: 'passed', differenceCents: 0 },
    });

    expect(await batchRow(result.batchId)).toMatchObject({
      accountId: t.h.account(JOINT).id,
      fileName: 'joint-2026-09.txt',
      source: 'pdf',
      dateFrom: '2026-09-01', // R1C：账期开始日的第二天
      dateTo: '2026-09-30',
      rowCount: 19,
      insertedCount: 19,
      openingBalanceCents: 500000,
      closingBalanceCents: 638510,
      reconciled: true,
    });
    // R12.2：没有上一份对账单，不提示
    expect((await batchRow(result.batchId)).warnings).toMatchObject({ statementContinuity: null });

    const fromPdf = await listTransactions(t, JOINT);
    // R1C：EFFECTIVE DATE 不进描述；余额不存
    for (const r of fromPdf) {
      expect(r.rawDescription).not.toContain('EFFECTIVE DATE');
      expect(r.balanceCents).toBeNull();
      expect(r.rawDescription).not.toMatch(/\d{8,}/); // R2.3
    }

    // 和只导入 CSV 的结果一样。先按这个家庭把 PDF 的结果转成名字，再重建家庭
    const pdfView = sorted(fromPdf);
    await resetBusinessTables();
    t = await createTestHousehold();
    await importCsvFixture('anz/joint-2026-09.csv');
    expect(pdfView).toEqual(sorted(await listTransactions(t, JOINT)));
  });

  it('S1 / R1C: the same statement as a PDF buffer goes through importStatement', async () => {
    const buffer = statementPdf('joint-2026-09.txt');
    const result = expectOk(
      await importStatement(t.ctx, {
        accountId: t.h.account(JOINT).id,
        fileName: 'joint-2026-09.pdf',
        buffer,
      }),
    );
    expect(result).toMatchObject({
      rowCount: 19,
      insertedCount: 19,
      reconciliation: { status: 'passed' },
    });
    expect(await batchRow(result.batchId)).toMatchObject({
      source: 'pdf',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
    });
  });

  it('S1: no full account number or masked digits anywhere in the database', async () => {
    expectOk(await importStatementFixture('joint-2026-09.txt'));
    expect(
      await findNumbersInDatabase([
        '123450001',
        '1234-50001',
        '400000002',
        '012345400000003',
        '499999999',
        '280672605',
      ]),
    ).toEqual([]);
  });

  it('S2 / R4: CSV first, then the statement: 0 new, 19 skipped, reconciled', async () => {
    await importCsvFixture('anz/joint-2026-09.csv');
    const result = expectOk(await importStatementFixture('joint-2026-09.txt'));
    expect(result).toMatchObject({
      rowCount: 19,
      insertedCount: 0,
      duplicateCount: 19,
      reconciliation: { status: 'passed' },
    });
    expect(await listTransactions(t, JOINT)).toHaveLength(19);
  });

  it('S3 / R4: CSV without #12, then the statement fills in #12 only', async () => {
    const csv = readFixture('anz/joint-2026-09.csv')
      .split(/\r?\n/)
      .filter((l) => !l.includes('CHARGEFOX'))
      .join('\n');
    const first = await importCsvFixture('anz/joint-2026-09.csv', csv);
    expect(first.insertedCount).toBe(18);

    const result = expectOk(await importStatementFixture('joint-2026-09.txt'));
    expect(result).toMatchObject({
      insertedCount: 1,
      duplicateCount: 18,
      reconciliation: { status: 'passed' },
    });
    const fresh = (await listTransactions(t, JOINT)).filter(
      (r) => r.importBatchId === result.batchId,
    );
    expect(fresh.map((r) => [r.date, r.amountCents, r.merchant])).toEqual([
      ['2026-09-12', -2500, 'CHARGEFOX PTY LTD NORTH MELBOUR'],
    ]);
  });

  it('S4 / R1C / R12.2: a statement with no transactions still makes a batch and connects', async () => {
    const s1 = expectOk(await importStatementFixture('joint-2026-09.txt'));
    const result = expectOk(await importStatementFixture('joint-2026-10.txt'));
    expect(result).toMatchObject({
      rowCount: 0,
      insertedCount: 0,
      duplicateCount: 0,
      openingBalanceCents: 638510,
      closingBalanceCents: 638510,
      reconciliation: { status: 'passed', differenceCents: 0 },
    });
    expect(result.warnings.statementContinuity).toEqual({
      status: 'connected',
      previous: { batchId: s1.batchId, dateFrom: '2026-09-01', dateTo: '2026-09-30' },
    });
    expect(await batchRow(result.batchId)).toMatchObject({
      source: 'pdf',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      rowCount: 0,
      reconciled: true,
    });
    expect((await batchRow(result.batchId)).warnings).toMatchObject({
      statementContinuity: { status: 'connected' },
    });
  });

  it('S5 / R12.2: opening is $100.00 more than the previous closing → warning, rows still imported', async () => {
    expectOk(await importStatementFixture('joint-2026-09.txt'));
    const s4 = expectOk(await importStatementFixture('joint-2026-10.txt'));
    const result = expectOk(await importStatementFixture('joint-2026-11-gap.txt'));
    expect(result).toMatchObject({ rowCount: 2, insertedCount: 2 });
    expect(result.warnings.statementContinuity).toEqual({
      status: 'mismatch',
      previous: { batchId: s4.batchId, dateFrom: '2026-10-01', dateTo: '2026-10-31' },
      differenceCents: 10000, // 本次期初 − 上一份期末
    });
  });

  it('R12.2: CSV batches are not the "previous statement"', async () => {
    await importCsvFixture('anz/joint-2026-09.csv');
    const result = expectOk(await importStatementFixture('joint-2026-10.txt'));
    expect(result.warnings.statementContinuity).toBeNull();
  });

  it('R12.2: CSV batches do not get a statementContinuity warning', async () => {
    const result = await importCsvFixture('anz/joint-2026-09.csv');
    expect(result.warnings).not.toHaveProperty('statementContinuity');
  });

  it('S6 / R1C: broken balance fails at page 2, transaction 3, nothing written', async () => {
    const result = await importStatementFixture('broken-balance.txt');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('parse');
    expect(result.page).toBe(2);
    expect(result.index).toBe(3);
    expect(result.message).toMatch(/^第 2 页第 3 笔：/);
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('S7 / R1C: wrong account fails without the full account number, nothing written', async () => {
    const result = await importStatementFixture('wrong-account.txt');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('这份对账单不是这个账户的');
    expect(result.message).not.toMatch(/1234-?5000[12]/);
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('R1C: only ANZ accounts can import a statement', async () => {
    const result = await importStatementLines(t.ctx, {
      accountId: t.h.account('CBA Female').id,
      fileName: 'joint-2026-09.txt',
      lines: readStatementFixture('joint-2026-09.txt'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_importable' });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('R1C: a PDF without readable text fails with 读不出文字, nothing written', async () => {
    const result = await importStatement(t.ctx, {
      accountId: t.h.account(JOINT).id,
      fileName: 'scan.pdf',
      buffer: new TextEncoder().encode('not a pdf at all'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'parse' });
    if (!result.ok) expect(result.message).toContain('读不出文字');
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('R1C: a PDF that is not a statement fails without crashing', async () => {
    const result = await importStatement(t.ctx, {
      accountId: t.h.account(JOINT).id,
      fileName: 'letter.pdf',
      buffer: makePdf([[{ x: 20, y: 800, text: 'Dear customer, thank you.' }]]),
    });
    expect(result).toMatchObject({ ok: false, reason: 'parse' });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('file check: only .pdf, up to 1.5 MB', async () => {
    const accountId = t.h.account(JOINT).id;
    const buffer = statementPdf('joint-2026-09.txt');
    expect(
      await importStatement(t.ctx, { accountId, fileName: 'joint.csv', buffer }),
    ).toMatchObject({ ok: false, reason: 'invalid_file', message: '只支持 .pdf 文件' });
    expect(
      await importStatement(t.ctx, {
        accountId,
        fileName: 'big.pdf',
        buffer: new Uint8Array(1.5 * 1024 * 1024 + 1),
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_file', message: '文件不能超过 1.5 MB' });
  });

  it('R12.1: undoing a statement import deletes only what it added; importing again gives the same result', async () => {
    const csv = readFixture('anz/joint-2026-09.csv')
      .split(/\r?\n/)
      .filter((l) => !l.includes('CHARGEFOX'))
      .join('\n');
    await importCsvFixture('anz/joint-2026-09.csv', csv);
    const before = sorted(await listTransactions(t, JOINT));

    const first = expectOk(await importStatementFixture('joint-2026-09.txt'));
    expect(first.insertedCount).toBe(1);
    const afterFirst = sorted(await listTransactions(t, JOINT));

    const undone = await undoImport(t.ctx, first.batchId);
    expect(undone).toMatchObject({ ok: true, deletedCount: 1, restoredPendingCount: 0 });
    expect(sorted(await listTransactions(t, JOINT))).toEqual(before);
    expect(await batchRow(first.batchId)).toBeUndefined();

    const again = expectOk(await importStatementFixture('joint-2026-09.txt'));
    expect(again).toMatchObject({ insertedCount: 1, duplicateCount: 18 });
    expect(sorted(await listTransactions(t, JOINT))).toEqual(afterFirst);
  });

  it('R8: a manual pending is confirmed by the statement row', async () => {
    const pendingId = await insertPending(t, {
      account: JOINT,
      date: '2026-09-11',
      amountCents: -2500,
      category: 'Uncategorised',
      member: 'Female',
      note: '充电',
    });
    const result = expectOk(await importStatementFixture('joint-2026-09.txt'));
    expect(result).toMatchObject({ insertedCount: 18, matchedPendingCount: 1 });
    expect(await getTransaction(pendingId)).toMatchObject({
      status: 'confirmed',
      source: 'manual',
      date: '2026-09-12',
      merchant: 'CHARGEFOX PTY LTD NORTH MELBOUR',
      importBatchId: result.batchId,
      note: '充电',
    });

    // 撤销：pending 恢复，其余 18 笔删掉
    const undone = await undoImport(t.ctx, result.batchId);
    expect(undone).toMatchObject({ ok: true, deletedCount: 18, restoredPendingCount: 1 });
    expect(await getTransaction(pendingId)).toMatchObject({
      status: 'pending',
      importBatchId: null,
      dedupeKey: null,
    });
  });

  it('R12.2: the previous statement is the one with the largest date_to before this one', async () => {
    // 先导 10 月，再补 9 月：9 月之前没有对账单，不提示
    expectOk(await importStatementFixture('joint-2026-10.txt'));
    const sep = expectOk(await importStatementFixture('joint-2026-09.txt'));
    expect(sep.warnings.statementContinuity).toBeNull();

    // 同一份再导一次（不撤销）：date_to 一样，不算上一份
    const sepAgain = expectOk(
      await importStatementLines(t.ctx, {
        accountId: t.h.account(JOINT).id,
        fileName: 'again.txt',
        lines: toStatementLines(readFixture('anz-statement/joint-2026-09.txt')),
      }),
    );
    expect(sepAgain.warnings.statementContinuity).toBeNull();
  });

  // ---------- M6.6-6：结果页、历史页要的字段 ----------

  it('M6.6-6: result view of S4 / S5 carries source and continuity', async () => {
    expectOk(await importStatementFixture('joint-2026-09.txt'));
    const s4 = expectOk(await importStatementFixture('joint-2026-10.txt'));
    const s5 = expectOk(await importStatementFixture('joint-2026-11-gap.txt'));

    expect(await getImportResult(t.ctx, s4.batchId)).toMatchObject({
      source: 'pdf',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      statementContinuity: { status: 'connected' },
      importGap: null,
    });
    expect(await getImportResult(t.ctx, s5.batchId)).toMatchObject({
      source: 'pdf',
      statementContinuity: { status: 'mismatch', differenceCents: 10000 },
      importGap: null,
    });
  });

  it('M6.6-6: result view of a CSV has no continuity; history marks CSV and PDF', async () => {
    const csv = await importCsvFixture('anz/joint-2026-09.csv');
    const pdf = expectOk(await importStatementFixture('joint-2026-10.txt'));

    expect(await getImportResult(t.ctx, csv.batchId)).toMatchObject({
      source: 'csv',
      statementContinuity: null,
      importGap: null,
    });
    const history = await listImportHistory(t.ctx);
    expect(history.map((r) => [r.batchId, r.source])).toEqual([
      [pdf.batchId, 'pdf'],
      [csv.batchId, 'csv'],
    ]);
  });

  // ---------- M6.6-6b：自动认账户（R1C） ----------

  const importUnassigned = (name: `${string}.txt`) =>
    importStatementLines(t.ctx, { fileName: name, lines: readStatementFixture(name) });

  async function setSuffix(account: string, numberSuffix: string) {
    await db
      .update(schema.financialAccount)
      .set({ numberSuffix })
      .where(eq(schema.financialAccount.id, t.h.account(account).id));
  }

  it('S11 / R1C: no account given → joint-2026-09.txt goes to ANZ Joint, same as S1', async () => {
    const result = expectOk(await importUnassigned('joint-2026-09.txt'));
    expect(result).toMatchObject({
      rowCount: 19,
      insertedCount: 19,
      reconciliation: { status: 'passed' },
    });
    expect(await batchRow(result.batchId)).toMatchObject({
      accountId: t.h.account(JOINT).id,
      source: 'pdf',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
    });
  });

  it('S11 / R1C: importStatement without accountId reads the PDF and finds the account', async () => {
    const result = expectOk(
      await importStatement(t.ctx, {
        fileName: 'joint.pdf',
        buffer: statementPdf('joint-2026-09.txt'),
      }),
    );
    expect((await batchRow(result.batchId)).accountId).toBe(t.h.account(JOINT).id);
  });

  it('S12 / R1C: wrong-account.txt (…0002) goes to ANZ Male, ANZ Joint stays empty', async () => {
    const result = expectOk(await importUnassigned('wrong-account.txt'));
    expect((await batchRow(result.batchId)).accountId).toBe(t.h.account('ANZ Male').id);
    expect(await listTransactions(t, JOINT)).toHaveLength(0);
    expect(await listTransactions(t, 'ANZ Male')).toHaveLength(19);
  });

  it('S13 / R1C: no ANZ suffix matches (a CBA one does not count) → fails, nothing written', async () => {
    await setSuffix(JOINT, '9999');
    await setSuffix('CBA Female', '0001');
    const result = await importUnassigned('joint-2026-09.txt');
    expect(result).toMatchObject({
      ok: false,
      reason: 'parse',
      message: '找不到尾号是 0001 的 ANZ 账户，先去账户设置填上尾号',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('R1C: archived ANZ accounts are not candidates', async () => {
    await db
      .update(schema.financialAccount)
      .set({ isArchived: true })
      .where(eq(schema.financialAccount.id, t.h.account(JOINT).id));
    const result = await importUnassigned('joint-2026-09.txt');
    expect(result).toMatchObject({ ok: false, reason: 'parse' });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('S14 / R1C: two ANZ suffixes match → fails, nothing written', async () => {
    await setSuffix('ANZ Male', '50001');
    const result = await importUnassigned('joint-2026-09.txt');
    expect(result).toMatchObject({
      ok: false,
      message: '有 2 个 ANZ 账户的尾号都对得上，去账户设置把尾号填长一点',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('M6.6-6b: identifyStatement returns the account and its coverage, writes nothing', async () => {
    await importCsvFixture('anz/joint-2026-09.csv');
    const before = await countRows();
    const r = await identifyStatement(t.ctx, {
      fileName: 'joint.pdf',
      buffer: statementPdf('joint-2026-10.txt'),
    });
    expect(r).toMatchObject({
      ok: true,
      account: { id: t.h.account(JOINT).id, name: JOINT, numberSuffix: '0001' },
      coverage: { lastDateTo: '2026-09-30', statementDateTo: null },
    });
    expect(await countRows()).toEqual(before);
  });

  it('M6.6-6b: identifyStatement fails for a PDF without text and for a wrong file', async () => {
    expect(
      await identifyStatement(t.ctx, {
        fileName: 'scan.pdf',
        buffer: new TextEncoder().encode('not a pdf at all'),
      }),
    ).toMatchObject({ ok: false, reason: 'parse' });
    expect(
      await identifyStatement(t.ctx, { fileName: 'a.csv', buffer: new Uint8Array(10) }),
    ).toMatchObject({ ok: false, reason: 'invalid_file' });
  });
});
