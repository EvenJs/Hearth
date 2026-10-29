// M6.6-5 防漏导提示（business-rules.md R12.2 前两条）
// 期望值来自 fixtures/README.md "ANZ 对账单用例" S9、S10
import { beforeEach, expect, it } from 'vitest';
import {
  getImportCoverage,
  importCsv,
  importStatementLines,
  undoImport,
  type ImportResult,
  type ImportSuccess,
} from '@/server/imports';
import { readFixture, readStatementFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

let t: DbTestHousehold;

const JOINT = 'ANZ Joint';
const TODAY = '2026-10-29';

function expectOk(result: ImportResult): ImportSuccess {
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result;
}

async function importCsvText(fileName: string, text: string, account = JOINT) {
  return expectOk(await importCsv(t.ctx, { accountId: t.h.account(account).id, fileName, text }));
}

const importCsvFixture = (path: FixturePath, account = JOINT) =>
  importCsvText(path, readFixture(path), account);

async function importStatementFixture(name: `${string}.txt`) {
  return expectOk(
    await importStatementLines(t.ctx, {
      accountId: t.h.account(JOINT).id,
      fileName: name,
      lines: readStatementFixture(name),
    }),
  );
}

const coverage = (account = JOINT) => getImportCoverage(t.ctx, t.h.account(account).id, TODAY);

// S10：测试里现拼一份最早是 2026-10-05 的 ANZ CSV（R1A 格式，新的在前，假数据）
const OCTOBER_CSV = [
  '12/10/2026,"-32.60",VISA DEBIT PURCHASE CARD 1111 COLES 0559 MELBOURNE',
  '05/10/2026,"-6.50",VISA DEBIT PURCHASE CARD 1111 GONG CHA & HO/SPENCER ST MELBOURNE',
].join('\n');

describeDb('M6.6-5 import coverage', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R12.2: account never imported → no coverage shown', async () => {
    expect(await coverage()).toEqual({
      lastDateTo: null,
      suggestedFrom: null,
      suggestedTo: null,
      statementDateTo: null,
    });
  });

  it('S9 / R12.2: after joint-2026-09.csv → last 2026-09-30, suggest 2026-09-23 to today', async () => {
    await importCsvFixture('anz/joint-2026-09.csv');
    expect(await coverage()).toEqual({
      lastDateTo: '2026-09-30',
      suggestedFrom: '2026-09-23',
      suggestedTo: TODAY,
      statementDateTo: null,
    });
    // 别的账户不受影响
    expect((await coverage('CBA Female')).lastDateTo).toBeNull();
  });

  it('S10 / R12.2: CSV starting 2026-10-05 after S9 → gap warning, rows still imported', async () => {
    await importCsvFixture('anz/joint-2026-09.csv');
    const result = await importCsvText('october.csv', OCTOBER_CSV);
    expect(result).toMatchObject({ rowCount: 2, insertedCount: 2 });
    expect(result.warnings.importGap).toEqual({
      dateFrom: '2026-10-05',
      previousDateTo: '2026-09-30',
    });
  });

  it('R12.2: first CSV import of an account has no gap warning', async () => {
    const result = await importCsvText('october.csv', OCTOBER_CSV);
    expect(result.warnings).not.toHaveProperty('importGap');
  });

  it('R12.2: an overlapping CSV has no gap warning', async () => {
    await importCsvFixture('anz/joint-2026-09.csv');
    const result = await importCsvFixture('anz/joint-2026-09-overlap.csv');
    expect(result.warnings).not.toHaveProperty('importGap');
  });

  it('R12.2: statements count towards "last imported" for the CSV gap check', async () => {
    await importStatementFixture('joint-2026-09.txt');
    const result = await importCsvText('october.csv', OCTOBER_CSV);
    expect(result.warnings.importGap).toEqual({
      dateFrom: '2026-10-05',
      previousDateTo: '2026-09-30',
    });
  });

  it('S1 → S4 / R12.2: two connected statements → no gap warning, statements up to 2026-10-31', async () => {
    const s1 = await importStatementFixture('joint-2026-09.txt');
    const s4 = await importStatementFixture('joint-2026-10.txt');
    expect(s1.warnings).not.toHaveProperty('importGap');
    expect(s4.warnings).not.toHaveProperty('importGap');
    expect(s4.warnings.statementContinuity).toMatchObject({ status: 'connected' });
    expect(await coverage()).toEqual({
      lastDateTo: '2026-10-31',
      suggestedFrom: '2026-10-24',
      suggestedTo: TODAY,
      statementDateTo: '2026-10-31',
    });
  });

  it('R12.2 / R12.1: undoing the latest import moves "last imported" back', async () => {
    await importCsvFixture('anz/joint-2026-09.csv');
    const overlap = await importCsvFixture('anz/joint-2026-09-overlap.csv');
    expect((await coverage()).lastDateTo).toBe('2026-10-08');

    expect(await undoImport(t.ctx, overlap.batchId)).toMatchObject({ ok: true });
    expect(await coverage()).toMatchObject({
      lastDateTo: '2026-09-30',
      suggestedFrom: '2026-09-23',
    });
  });

  it('R12.2: undoing the only statement clears "statements up to"', async () => {
    await importCsvFixture('anz/joint-2026-09.csv');
    const s1 = await importStatementFixture('joint-2026-09.txt');
    expect((await coverage()).statementDateTo).toBe('2026-09-30');

    expect(await undoImport(t.ctx, s1.batchId)).toMatchObject({ ok: true });
    expect(await coverage()).toMatchObject({ lastDateTo: '2026-09-30', statementDateTo: null });
  });
});
