// M5.5-4 F8 改完之后的追问：存成规则（R16.9）、同商家一起改归属人（R16.10）
// 期望值来自 business-rules.md R16.9、R16.10 的例子和 fixtures/README.md（joint #4、#5、#13 到 #15）
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { applyMemberPropagation, getRuleOffer, previewMemberPropagation } from '@/server/follow-up';
import { importCsv } from '@/server/imports';
import { updateSplitMember } from '@/server/transactions';
import { readFixture } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  TEST_USER,
  type DbTestHousehold,
} from './helpers/db';
import { listTransactions } from './helpers/transactions';

let t: DbTestHousehold;

async function importJoint(h: DbTestHousehold) {
  const result = await importCsv(h.ctx, {
    accountId: h.h.account('ANZ Joint').id,
    fileName: 'anz/joint-2026-09.csv',
    text: readFixture('anz/joint-2026-09.csv'),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
}

async function jointRows(h: DbTestHousehold, date: string, amountCents: number) {
  return (await listTransactions(h, 'ANZ Joint')).filter(
    (r) => r.date === date && r.amountCents === amountCents,
  );
}
async function jointTx(h: DbTestHousehold, date: string, amountCents: number) {
  const rows = await jointRows(h, date, amountCents);
  expect(rows, `joint ${date} ${amountCents}`).toHaveLength(1);
  return rows[0];
}
const J14 = (h = t) => jointTx(h, '2026-09-10', -6230);
const J15 = (h = t) => jointTx(h, '2026-09-08', -1200);
// #4、#5 同一天同金额（GONG CHA 两笔），按列表顺序取
async function gongCha(h = t) {
  const rows = await jointRows(h, '2026-09-28', -450);
  expect(rows).toHaveLength(2);
  return { j4: rows[0], j5: rows[1] };
}

async function primarySplitId(transactionId: string) {
  const [s] = await db
    .select({ id: schema.transactionSplit.id })
    .from(schema.transactionSplit)
    .where(
      and(
        eq(schema.transactionSplit.transactionId, transactionId),
        eq(schema.transactionSplit.isPrimary, true),
      ),
    );
  return s.id;
}

const EXPENSE = { isPrimary: true, changed: true, newKind: 'expense' } as const;

describeDb('M5.5-4 getRuleOffer / previewMemberPropagation / applyMemberPropagation', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    await importJoint(t);
  });

  // ---------- R16.9 ----------

  it('R16.9: #14 MELB ASIAN MARKET → dialog (#13 has the same merchant)', async () => {
    expect(await getRuleOffer(t.ctx, (await J14()).id, EXPENSE)).toBe('dialog');
  });

  it('R16.9: #15 UNKNOWN SHOP PTY LTD MELBOURNE → toast (only itself)', async () => {
    expect(await getRuleOffer(t.ctx, (await J15()).id, EXPENSE)).toBe('toast');
  });

  it('R16.9: changed to Uncategorised, not changed, or not the primary split → none', async () => {
    const id = (await J14()).id;
    expect(await getRuleOffer(t.ctx, id, { ...EXPENSE, newKind: 'system' })).toBe('none');
    expect(await getRuleOffer(t.ctx, id, { ...EXPENSE, changed: false })).toBe('none');
    expect(await getRuleOffer(t.ctx, id, { ...EXPENSE, isPrimary: false })).toBe('none');
  });

  it("R16.9: another household's transactions do not count as similar", async () => {
    await db.delete(schema.householdUser).where(eq(schema.householdUser.userId, TEST_USER.id));
    const other = await createTestHousehold();
    await importJoint(other);
    // 另一个家庭也有 UNKNOWN SHOP，本家庭还是只有自己这一笔
    expect(await getRuleOffer(t.ctx, (await J15()).id, EXPENSE)).toBe('toast');
    // 别家的交易 id 在本家庭查不到 → none
    expect(await getRuleOffer(t.ctx, (await J14(other)).id, EXPENSE)).toBe('none');
  });

  // ---------- R16.10 ----------

  it('R16.10: #4 changed to Female → 1 more (#5, Male card); confirm → #5 is Female (manual)', async () => {
    const { j4, j5 } = await gongCha();
    const female = t.h.member('Female').id;
    const split4 = await primarySplitId(j4.id);
    await updateSplitMember(t.ctx, split4, female);

    expect(await previewMemberPropagation(t.ctx, split4)).toEqual({
      keyword: 'GONG CHA & HO/SPENCER ST MELBOURNE',
      count: 1,
      memberName: 'Female',
    });
    expect(await applyMemberPropagation(t.ctx, j4.id, female)).toEqual({
      ok: true,
      updatedCount: 1,
    });

    const after = (await listTransactions(t, 'ANZ Joint')).find((r) => r.id === j5.id)!;
    expect(after).toMatchObject({ memberId: female, memberSource: 'manual' });
    // 再问一次：没有要改的了，不弹
    expect(await previewMemberPropagation(t.ctx, split4)).toMatchObject({ count: 0 });
  });

  it('R16.10: #5 already set by hand (manual) → 0, not touched', async () => {
    const { j4, j5 } = await gongCha();
    const male = t.h.member('Male').id;
    const female = t.h.member('Female').id;
    await updateSplitMember(t.ctx, await primarySplitId(j5.id), male); // manual Male
    const split4 = await primarySplitId(j4.id);
    await updateSplitMember(t.ctx, split4, female);

    expect(await previewMemberPropagation(t.ctx, split4)).toMatchObject({ count: 0 });
    expect(await applyMemberPropagation(t.ctx, j4.id, female)).toEqual({
      ok: true,
      updatedCount: 0,
    });
    const after = (await listTransactions(t, 'ANZ Joint')).find((r) => r.id === j5.id)!;
    expect(after).toMatchObject({ memberId: male, memberSource: 'manual' });
  });

  it("R16.10: another household's GONG CHA is not changed", async () => {
    await db.delete(schema.householdUser).where(eq(schema.householdUser.userId, TEST_USER.id));
    const other = await createTestHousehold();
    await importJoint(other);

    const { j4 } = await gongCha();
    const female = t.h.member('Female').id;
    await updateSplitMember(t.ctx, await primarySplitId(j4.id), female);
    expect(await applyMemberPropagation(t.ctx, j4.id, female)).toEqual({
      ok: true,
      updatedCount: 1,
    });

    const { j4: o4, j5: o5 } = await gongCha(other);
    for (const r of [o4, o5]) {
      expect(r).toMatchObject({ memberId: other.h.member('Male').id, memberSource: 'card' });
    }
    // 别家的交易 id、别家的归属人在本家庭都用不了
    expect((await applyMemberPropagation(t.ctx, o4.id, female)).ok).toBe(false);
    expect((await applyMemberPropagation(t.ctx, j4.id, other.h.member('Female').id)).ok).toBe(
      false,
    );
  });
});
