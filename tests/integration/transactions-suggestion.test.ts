// M4-5 建议转账确认和拒绝（business-rules.md R6.3）
// 期望值来自 docs/tasks/m4.md M4-5 完成标准和 fixtures/README.md "R6.3 确认和拒绝"
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { importCsv } from '@/server/imports';
import { reapplyRules } from '@/server/rules';
import { confirmSuggestion, rejectSuggestion } from '@/server/transactions';
import { readFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { getSplits, getTransaction } from './helpers/transactions';

let t: DbTestHousehold;

async function importFixture(account: string, path: FixturePath): Promise<void> {
  const result = await importCsv(t.ctx, {
    accountId: t.h.account(account).id,
    fileName: path,
    text: readFixture(path),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
}

async function txId(account: string, merchant: string): Promise<string> {
  const rows = await db
    .select({ id: schema.transaction.id })
    .from(schema.transaction)
    .where(
      and(
        eq(schema.transaction.householdId, t.ctx.householdId),
        eq(schema.transaction.accountId, t.h.account(account).id),
        eq(schema.transaction.merchant, merchant),
      ),
    );
  if (rows.length !== 1) throw new Error(`${account} ${merchant} 有 ${rows.length} 笔`);
  return rows[0].id;
}

// joint #7 和 me 的 PAYID PAYMENT（fixtures/README.md：导入 me 后互为兜底建议）
async function suggestedPair() {
  await importFixture('ANZ Joint', 'anz/joint-2026-09.csv');
  await importFixture('ANZ Male', 'anz/me-2026-09.csv');
  const joint = await txId('ANZ Joint', 'PAYID DEPOSIT REF DINNER SPLIT');
  const male = await txId('ANZ Male', 'PAYID PAYMENT REF DINNER SPLIT');
  return { joint, male };
}

// 交易 + 唯一的拆分，换成名字方便比较
async function describeTx(id: string) {
  const row = await getTransaction(id);
  const [s, ...rest] = await getSplits(id);
  expect(rest).toEqual([]);
  const cat = t.h.categories.find((c) => c.id === s.categoryId)!;
  return {
    transferStatus: row.transferStatus,
    transferPairId: row.transferPairId,
    category: cat.nameEn,
    categorySource: s.categorySource,
    member: t.h.members.find((m) => m.id === s.memberId)!.name,
    memberSource: s.memberSource,
  };
}

describeDb('M4-5 confirmSuggestion / rejectSuggestion', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  // ---------- 完成标准 ----------

  it('R6.3 confirm: both sides confirmed, Internal transfer, manual, members unchanged, pair kept', async () => {
    const { joint, male } = await suggestedPair();
    expect(await describeTx(joint)).toMatchObject({
      transferStatus: 'suggested',
      transferPairId: male,
    });

    expect(await confirmSuggestion(t.ctx, joint)).toEqual({ ok: true });

    expect(await describeTx(joint)).toEqual({
      transferStatus: 'confirmed',
      transferPairId: male,
      category: 'Internal transfer',
      categorySource: 'manual',
      member: 'Home',
      memberSource: 'account',
    });
    expect(await describeTx(male)).toEqual({
      transferStatus: 'confirmed',
      transferPairId: joint,
      category: 'Internal transfer',
      categorySource: 'manual',
      member: 'Male',
      memberSource: 'account',
    });
  });

  it('R6.3 reject: both sides none, still Uncategorised, pair cleared', async () => {
    const { joint, male } = await suggestedPair();
    const before = { joint: await describeTx(joint), male: await describeTx(male) };

    expect(await rejectSuggestion(t.ctx, joint)).toEqual({ ok: true });

    for (const [id, b] of [
      [joint, before.joint],
      [male, before.male],
    ] as const) {
      expect(await describeTx(id)).toEqual({
        ...b,
        transferStatus: 'none',
        transferPairId: null,
        category: 'Uncategorised',
      });
    }
  });

  it('after reject, importing cba/female-2026-09.csv does not suggest the two again', async () => {
    const { joint, male } = await suggestedPair();
    await rejectSuggestion(t.ctx, male);
    await importFixture('CBA Female', 'cba/female-2026-09.csv');

    for (const id of [joint, male]) {
      expect(await describeTx(id)).toMatchObject({
        transferStatus: 'none',
        transferPairId: null,
        category: 'Uncategorised',
      });
    }
  });

  // ---------- 其他 ----------

  it('can be started from either side', async () => {
    const { joint, male } = await suggestedPair();
    expect(await confirmSuggestion(t.ctx, male)).toEqual({ ok: true });
    expect((await describeTx(joint)).transferStatus).toBe('confirmed');
  });

  it('not suggested → ok: false, nothing changes (auto, normal, already confirmed or rejected)', async () => {
    const { joint, male } = await suggestedPair();
    const auto = await txId('ANZ Joint', 'TRANSFER TO ****0003');
    const coles = await txId('ANZ Joint', 'COLES 0559 MELBOURNE');
    const autoBefore = await describeTx(auto);

    expect(await confirmSuggestion(t.ctx, auto)).toMatchObject({ ok: false });
    expect(await rejectSuggestion(t.ctx, auto)).toMatchObject({ ok: false });
    expect(await confirmSuggestion(t.ctx, coles)).toMatchObject({ ok: false });
    expect(await describeTx(auto)).toEqual(autoBefore);

    await confirmSuggestion(t.ctx, joint);
    expect(await confirmSuggestion(t.ctx, male)).toMatchObject({ ok: false });
    expect(await rejectSuggestion(t.ctx, joint)).toMatchObject({ ok: false });
    expect((await describeTx(male)).transferStatus).toBe('confirmed');
  });

  it('unknown, malformed or other-household id → ok: false', async () => {
    const { joint } = await suggestedPair();
    const before = await describeTx(joint);
    const [other] = await db
      .insert(schema.household)
      .values({ name: 'Other Household' })
      .returning({ id: schema.household.id });
    const otherCtx = { ...t.ctx, householdId: other.id, memberId: null };

    expect(await confirmSuggestion(otherCtx, joint)).toMatchObject({ ok: false });
    expect(await rejectSuggestion(otherCtx, joint)).toMatchObject({ ok: false });
    expect(await confirmSuggestion(t.ctx, '00000000-0000-4000-8000-000000000000')).toMatchObject({
      ok: false,
    });
    expect(await confirmSuggestion(t.ctx, 'not-a-uuid')).toMatchObject({ ok: false });
    expect(await describeTx(joint)).toEqual(before);
  });

  it('confirmed category is manual, so R7.2 reapply does not touch it', async () => {
    const { joint, male } = await suggestedPair();
    await confirmSuggestion(t.ctx, joint);
    const before = [await describeTx(joint), await describeTx(male)];
    await reapplyRules(t.ctx);
    expect([await describeTx(joint), await describeTx(male)]).toEqual(before);
  });
});
