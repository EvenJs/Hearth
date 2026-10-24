// M3-9 导入历史（business-rules.md R12.1：每个账户只能撤销最近一次导入）
// 期望值来自 fixtures/README.md U1，以及 M3-3 的 overlap 计数 9 / 3 / 6
import { beforeEach, expect, it } from 'vitest';
import { getImportResult, importCsv, listImportHistory, undoImport } from '@/server/imports';
import { readFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

let t: DbTestHousehold;

async function importFixture(account: string, path: FixturePath): Promise<string> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account(account).id,
    fileName: path,
    text: readFixture(path),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result.batchId;
}

const summary = async () =>
  (await listImportHistory(t.ctx)).map((r) => ({
    fileName: r.fileName,
    account: r.account.name,
    canUndo: r.canUndo,
  }));

describeDb('M3-9 listImportHistory', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('empty household → no rows', async () => {
    expect(await listImportHistory(t.ctx)).toEqual([]);
  });

  it('R12.1 U1: joint → overlap → me: newest first, only the latest per account can undo', async () => {
    const joint = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const overlap = await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');
    await importFixture('ANZ Male', 'anz/me-2026-09.csv');

    expect(await summary()).toEqual([
      { fileName: 'anz/me-2026-09.csv', account: 'ANZ Male', canUndo: true },
      { fileName: 'anz/joint-2026-09-overlap.csv', account: 'ANZ Joint', canUndo: true },
      { fileName: 'anz/joint-2026-09.csv', account: 'ANZ Joint', canUndo: false },
    ]);

    // 结果页的 canUndo 和历史页一致
    expect((await getImportResult(t.ctx, joint))?.canUndo).toBe(false);
    expect((await getImportResult(t.ctx, overlap))?.canUndo).toBe(true);

    const rows = await listImportHistory(t.ctx);
    const o = rows.find((r) => r.batchId === overlap)!;
    expect(o).toMatchObject({ insertedCount: 3, duplicateCount: 6, matchedPendingCount: 0 });
    expect(o.reconciliation.status).toBe('none'); // ANZ 没填余额
  });

  it('R12.1 U1: after undoing overlap it disappears and the joint batch becomes undoable', async () => {
    const joint = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const overlap = await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');

    const r = await undoImport(t.ctx, overlap);
    expect(r.ok).toBe(true);

    expect(await summary()).toEqual([
      { fileName: 'anz/joint-2026-09.csv', account: 'ANZ Joint', canUndo: true },
    ]);
    expect((await getImportResult(t.ctx, joint))?.canUndo).toBe(true);
  });

  it('cba shows the stored reconciliation', async () => {
    await importFixture('CBA Female', 'cba/female-2026-09.csv');
    const [row] = await listImportHistory(t.ctx);
    expect(row.reconciliation).toEqual({ status: 'passed', differenceCents: 0 });
  });

  it('another household sees nothing', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(await listImportHistory({ ...t.ctx, householdId: crypto.randomUUID() })).toEqual([]);
  });
});
