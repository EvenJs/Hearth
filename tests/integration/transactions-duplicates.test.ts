// M6-6 F8 里的可能重复提示（R16.8、R17.6）：列表标签带上对方、提示条的 N、quick = duplicates 筛选
// 期望值来自 business-rules.md R17.6 和 fixtures/README.md "pending 匹配用例"（P3、P4 和 #12）
import { beforeEach, expect, it } from 'vitest';
import { importCsv } from '@/server/imports';
import { createManualTransaction, deleteManualTransaction } from '@/server/manual';
import { listTransactions as listF8 } from '@/server/transactions';
import type { TransactionFilters } from '@/lib/transactions/filters';
import { readFixture } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { listTransactions } from './helpers/transactions';

const TODAY = '2026-10-26';
let t: DbTestHousehold;

async function joint(date: string, amount: string, category: string | null, member: string) {
  const r = await createManualTransaction(
    t.ctx,
    {
      amount,
      kind: 'expense',
      description: 'Manual entry',
      accountId: t.h.account('ANZ Joint').id,
      date,
      categoryId: category ? t.h.category(category).id : null,
      categoryGuessed: false,
      memberId: t.h.member(member).id,
    },
    TODAY,
  );
  if (!r.ok) throw new Error(`录入失败: ${JSON.stringify(r.errors)}`);
  return r.id;
}

// fixtures 的 P1 到 P6（ANZ Joint），录完导入 joint-2026-09.csv
async function setup() {
  const P = {
    P1: await joint('2026-09-20', '61.20', 'Entertainment & eat-out / Coffee & tea', 'Female'),
    P2: await joint('2026-09-20', '38.75', 'Groceries / Supermarket', 'Male'),
    P3: await joint('2026-09-11', '25.00', null, 'Home'),
    P4: await joint('2026-09-12', '25.00', null, 'Home'),
    P5: await joint('2026-09-05', '10.00', null, 'Home'),
    P6: await joint('2026-09-02', '58.40', 'Groceries / Supermarket', 'Home'),
  };
  const path = 'anz/joint-2026-09.csv';
  const result = await importCsv(t.ctx, {
    accountId: t.h.account('ANZ Joint').id,
    fileName: path,
    text: readFixture(path),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  const n12 = (await listTransactions(t, 'ANZ Joint')).find(
    (r) => r.source === 'csv' && r.amountCents === -2500,
  )!.id;
  return { ...P, n12 };
}

const list = (filters: TransactionFilters = {}) =>
  listF8(t.ctx, filters, { today: TODAY, pageSize: 200 });

const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();

describeDb('possible duplicates in F8 (M6-6)', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R17.6: after import #12, P3, P4 are flagged with their partners; banner counts 2 (pending only)', async () => {
    const { P1, P3, P4, n12 } = await setup();
    const all = await list();

    expect(all.duplicatePendingCount).toBe(2);
    expect(ids(all.items.filter((i) => i.possibleDuplicate))).toEqual([n12, P3, P4].sort());

    const item = (id: string) => all.items.find((i) => i.id === id)!;
    expect(ids(item(n12).duplicatePartners)).toEqual([P3, P4].sort());
    expect(ids(item(P3).duplicatePartners)).toEqual([n12, P4].sort());
    expect(item(P3).duplicatePartners.find((p) => p.id === P4)).toMatchObject({
      status: 'pending',
      amountCents: -2500,
      date: '2026-09-12',
      account: { name: 'ANZ Joint' },
    });
    expect(item(P1).possibleDuplicate).toBe(false);
    expect(item(P1).duplicatePartners).toEqual([]);
  });

  it('quick = duplicates lists #12, P3, P4 (pending and the bank row), count and total match', async () => {
    const { P3, P4, n12 } = await setup();
    const r = await list({ quick: 'duplicates' });
    expect(ids(r.items)).toEqual([n12, P3, P4].sort());
    expect(r.count).toBe(3);
    expect(r.totalCents).toBe(-7500);
    // 提示条的 N 不跟着筛选变
    expect(r.duplicatePendingCount).toBe(2);
  });

  it('quick = duplicates combines with other filters', async () => {
    await setup();
    const other = await list({ quick: 'duplicates', accountId: t.h.account('ANZ Male').id });
    expect(other.items).toEqual([]);
    expect(other.count).toBe(0);
    expect(other.totalCents).toBe(0);
  });

  it('R17.6: delete P4 → #12, P3 still flagged, banner 1; delete P3 → nothing flagged, banner 0', async () => {
    const { P3, P4, n12 } = await setup();

    expect(await deleteManualTransaction(t.ctx, P4)).toEqual({ ok: true });
    let r = await list({ quick: 'duplicates' });
    expect(ids(r.items)).toEqual([n12, P3].sort());
    expect(r.duplicatePendingCount).toBe(1);
    expect(ids(r.items.find((i) => i.id === n12)!.duplicatePartners)).toEqual([P3]);

    expect(await deleteManualTransaction(t.ctx, P3)).toEqual({ ok: true });
    r = await list({ quick: 'duplicates' });
    expect(r.items).toEqual([]);
    expect(r.duplicatePendingCount).toBe(0);
    expect((await list()).items.some((i) => i.possibleDuplicate)).toBe(false);
  });

  it('no imports yet → banner 0, quick = duplicates matches nothing', async () => {
    await joint('2026-09-11', '25.00', null, 'Home');
    const r = await list({ quick: 'duplicates' });
    expect(r.items).toEqual([]);
    expect(r.count).toBe(0);
    expect(r.duplicatePendingCount).toBe(0);
  });
});
