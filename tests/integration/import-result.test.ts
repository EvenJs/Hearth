// M3-8 导入结果页的数据（business-rules.md R12 第 10 步、R8.4、R9、R1B.1）
// 期望值来自 fixtures/README.md
import { beforeEach, expect, it } from 'vitest';
import { getImportResult, importCsv, type ImportInput } from '@/server/imports';
import { readFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { insertPending } from './helpers/transactions';

let t: DbTestHousehold;

async function importFixture(
  account: string,
  path: FixturePath,
  extra: Partial<ImportInput> = {},
): Promise<string> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account(account).id,
    fileName: path,
    text: readFixture(path),
    ...extra,
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result.batchId;
}

async function load(batchId: string) {
  const r = await getImportResult(t.ctx, batchId);
  if (!r) throw new Error('结果不存在');
  return r;
}

describeDb('M3-8 getImportResult', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('cba/female-2026-09.csv: 20 inserted, no balance warnings, reconciled 10,000.00 → 11,561.59', async () => {
    const id = await importFixture('CBA Female', 'cba/female-2026-09.csv');
    const r = await load(id);
    expect(r).toMatchObject({
      batchId: id,
      fileName: 'cba/female-2026-09.csv',
      account: { name: 'CBA Female', bank: 'cba' },
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
      rowCount: 20,
      insertedCount: 20,
      duplicateCount: 0,
      matchedPendingCount: 0,
      openingBalanceCents: 1000000,
      closingBalanceCents: 1156159,
      reconciliation: { status: 'passed', differenceCents: 0 },
      balanceWarnings: [],
      possibleDuplicates: [],
      pendingToCheck: [],
    });
    // 单独导入（joint 没导入）：#3、#10、#12、#13、#15。#10 要等 joint #11 配对后才变成转账
    expect(r.uncategorizedCount).toBe(5);
  });

  it('after joint → overlap → me → cba the cba batch has 4 uncategorised (#10 is a transfer)', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    await importFixture('ANZ Joint', 'anz/joint-2026-09-overlap.csv');
    await importFixture('ANZ Male', 'anz/me-2026-09.csv');
    const id = await importFixture('CBA Female', 'cba/female-2026-09.csv');
    expect((await load(id)).uncategorizedCount).toBe(4);
  });

  it('R1B.1: broken-balance.csv shows 2 balance warnings and still reconciles', async () => {
    const r = await load(await importFixture('CBA Female', 'cba/broken-balance.csv'));
    expect(r.insertedCount).toBe(3);
    expect(r.balanceWarnings).toHaveLength(2);
    expect(r.balanceWarnings[0].message).toMatch(/余额不连续/);
    expect(r.reconciliation).toEqual({ status: 'passed', differenceCents: 0 });
  });

  it('R9: ANZ without balances → none; with wrong balances → failed with the difference', async () => {
    const none = await load(await importFixture('ANZ Joint', 'anz/joint-2026-09.csv'));
    expect(none.reconciliation).toEqual({ status: 'none', differenceCents: null });
    expect(none).toMatchObject({ openingBalanceCents: null, closingBalanceCents: null });

    await resetBusinessTables();
    t = await createTestHousehold();
    const off = await load(
      await importFixture('ANZ Joint', 'anz/joint-2026-09.csv', {
        openingBalanceCents: 100000,
        closingBalanceCents: 240000,
      }),
    );
    expect(off.reconciliation).toEqual({ status: 'failed', differenceCents: 1490 });
  });

  it('R4: importing the same file again → all skipped', async () => {
    await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    const r = await load(await importFixture('ANZ Joint', 'anz/joint-2026-09.csv'));
    expect(r).toMatchObject({ rowCount: 19, insertedCount: 0, duplicateCount: 19 });
    expect(r.uncategorizedCount).toBe(0);
  });

  it('R8: P1 to P6 then joint → 2 confirmed pendings, #12 possible duplicate of P3/P4, P3 to P6 to check', async () => {
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

    const r = await load(await importFixture('ANZ Joint', 'anz/joint-2026-09.csv'));
    expect(r).toMatchObject({ insertedCount: 17, matchedPendingCount: 2 });
    expect(r.uncategorizedCount).toBe(4);

    expect(r.pendingToCheck.map((p) => p.id)).toEqual([P6, P5, P3, P4]);
    expect(r.pendingToCheck[0]).toEqual({
      id: P6,
      date: '2026-09-02',
      amountCents: -5840,
      merchant: 'MANUAL ENTRY',
      memberName: 'Home',
      note: null,
    });

    expect(r.possibleDuplicates).toHaveLength(1);
    const dup = r.possibleDuplicates[0];
    expect(dup.transaction).toMatchObject({ amountCents: -2500 });
    expect(dup.pendings.map((p) => p.id).sort()).toEqual([P3, P4].sort());
  });

  it('a batch of another household or a bad id → null', async () => {
    const id = await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
    expect(await getImportResult({ ...t.ctx, householdId: crypto.randomUUID() }, id)).toBeNull();
    expect(await getImportResult(t.ctx, crypto.randomUUID())).toBeNull();
  });
});
