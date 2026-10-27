// M5.5-3 保存带尾号的账户时重新识别旧转账（business-rules.md R6.4、R6.2）
// 期望值来自 business-rules.md R6.4 例子 1 和 fixtures/README.md（joint #11、#18，cba #10）
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { AccountValues } from '@/lib/accounts/account-input';
import { createAccount, previewTransferRedetect, updateAccount } from '@/server/accounts';
import { importCsv } from '@/server/imports';
import { rejectSuggestion, updateSplitCategory } from '@/server/transactions';
import { readFixture, type FixturePath } from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  TEST_USER,
  type DbTestHousehold,
} from './helpers/db';
import { getTransaction, listTransactions } from './helpers/transactions';

let t: DbTestHousehold;

async function importFixture(h: DbTestHousehold, account: string, path: FixturePath) {
  const result = await importCsv(h.ctx, {
    accountId: h.h.account(account).id,
    fileName: path,
    text: readFixture(path),
  });
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
}

// R6.4 例子 1：CBA Female 先不填尾号
async function clearFemaleSuffix(h: DbTestHousehold) {
  await db
    .update(schema.financialAccount)
    .set({ numberSuffix: null })
    .where(eq(schema.financialAccount.id, h.h.account('CBA Female').id));
}

// 账户表单提交的值：照测试家庭里的账户，尾号换掉
function femaleValues(h: DbTestHousehold, numberSuffix: string | null): AccountValues {
  const a = h.h.account('CBA Female');
  return {
    name: a.name,
    bank: a.bank,
    type: a.type,
    defaultMemberId: a.defaultMemberId,
    numberSuffix,
  };
}

async function suffixOf(accountId: string) {
  const [row] = await db
    .select({ numberSuffix: schema.financialAccount.numberSuffix })
    .from(schema.financialAccount)
    .where(eq(schema.financialAccount.id, accountId));
  return row.numberSuffix;
}

async function txIn(h: DbTestHousehold, account: string, date: string, amountCents: number) {
  const rows = (await listTransactions(h, account)).filter(
    (r) => r.date === date && r.amountCents === amountCents,
  );
  expect(rows, `${account} ${date} ${amountCents}`).toHaveLength(1);
  return rows[0];
}
const J11 = (h = t) => txIn(h, 'ANZ Joint', '2026-09-15', -50000);
const J18 = (h = t) => txIn(h, 'ANZ Joint', '2026-09-02', 30000);
const CBA10 = (h = t) => txIn(h, 'CBA Female', '2026-09-16', 50000);

// #11 没认出来时的样子：和 #18 一样是 Uncategorised、Home（account）
async function expectJ11Uncategorised(h = t) {
  expect(await J11(h)).toMatchObject({
    transferStatus: 'none',
    transferPairId: null,
    categoryId: h.h.systemCategory('uncategorized').id,
    categorySource: 'system',
    memberId: h.h.member('Home').id,
    memberSource: 'account',
  });
}

describeDb('M5.5-3 previewTransferRedetect / updateAccount / createAccount（R6.4）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    await clearFemaleSuffix(t);
    await importFixture(t, 'ANZ Joint', 'anz/joint-2026-09.csv');
  });

  it('R6.4 例子 1 end to end: fill 0003 on CBA Female → #11 auto; import cba → #11 pairs with CBA #10', async () => {
    await expectJ11Uncategorised();

    const female = t.h.account('CBA Female').id;
    expect(await previewTransferRedetect(t.ctx, female, femaleValues(t, '0003'))).toEqual({
      count: 1,
      keptCount: 0,
    });
    // CBA 还没导入，另一半不在，配不上（R6.2 找到 0 笔不影响它是转账）
    expect(await updateAccount(t.ctx, female, femaleValues(t, '0003'), { redetect: true })).toEqual(
      { redetectedCount: 1, pairedCount: 0 },
    );

    expect(await suffixOf(female)).toBe('0003');
    expect(await J11()).toMatchObject({
      transferStatus: 'auto',
      transferPairId: null,
      categoryId: t.h.systemCategory('internal_transfer').id,
      categorySource: 'system',
      isPreTax: false,
      memberId: t.h.member('Home').id,
      memberSource: 'account',
    });
    // #18 是外部账号（****9999），不动
    expect(await J18()).toMatchObject({ transferStatus: 'none', categorySource: 'system' });

    await importFixture(t, 'CBA Female', 'cba/female-2026-09.csv');
    const j11 = await J11();
    const c10 = await CBA10();
    expect(j11.transferPairId).toBe(c10.id);
    expect(c10.transferPairId).toBe(j11.id);
    expect(c10).toMatchObject({
      transferStatus: 'auto',
      categoryId: t.h.systemCategory('internal_transfer').id,
    });
  });

  it('R6.4: suggested (R6.3) is not a candidate; after rejecting it, saving pairs with the other half (R6.2)', async () => {
    // 尾号没填时导入 cba：#11 和 CBA #10 金额相反、都是未分类 → R6.3 互为建议
    await importFixture(t, 'CBA Female', 'cba/female-2026-09.csv');
    expect(await J11()).toMatchObject({ transferStatus: 'suggested' });
    const female = t.h.account('CBA Female').id;
    expect(await previewTransferRedetect(t.ctx, female, femaleValues(t, '0003'))).toEqual({
      count: 0,
      keptCount: 0,
    });

    // 拒绝后两边都是 none、没配对，保存时 #11 认成转账，另一半已经在了，同一个事务里配上
    expect(await rejectSuggestion(t.ctx, (await J11()).id)).toEqual({ ok: true });
    expect(await updateAccount(t.ctx, female, femaleValues(t, '0003'), { redetect: true })).toEqual(
      { redetectedCount: 1, pairedCount: 1 },
    );
    const j11 = await J11();
    const c10 = await CBA10();
    expect(j11).toMatchObject({ transferStatus: 'auto', transferPairId: c10.id });
    expect(c10).toMatchObject({
      transferStatus: 'auto',
      transferPairId: j11.id,
      categoryId: t.h.systemCategory('internal_transfer').id,
      categorySource: 'system',
    });
  });

  it('R6.4 "不改": suffix is saved, #11 stays Uncategorised, the next save asks again', async () => {
    const female = t.h.account('CBA Female').id;
    expect(await updateAccount(t.ctx, female, femaleValues(t, '0003'))).toEqual({
      redetectedCount: 0,
      pairedCount: 0,
    });
    expect(await suffixOf(female)).toBe('0003');
    await expectJ11Uncategorised();
    expect(await previewTransferRedetect(t.ctx, female, femaleValues(t, '0003'))).toEqual({
      count: 1,
      keptCount: 0,
    });
  });

  it('R6.4: after changing, saving again → N = 0 (no dialog)', async () => {
    const female = t.h.account('CBA Female').id;
    await updateAccount(t.ctx, female, femaleValues(t, '0003'), { redetect: true });
    expect(await previewTransferRedetect(t.ctx, female, femaleValues(t, '0003'))).toEqual({
      count: 0,
      keptCount: 0,
    });
    expect(await updateAccount(t.ctx, female, femaleValues(t, '0003'), { redetect: true })).toEqual(
      { redetectedCount: 0, pairedCount: 0 },
    );
  });

  it('R6.4: empty suffix → N = 0', async () => {
    const female = t.h.account('CBA Female').id;
    expect(await previewTransferRedetect(t.ctx, female, femaleValues(t, null))).toEqual({
      count: 0,
      keptCount: 0,
    });
  });

  it('R6.4: manual category → counted in M, not changed even when saving with redetect', async () => {
    const restaurants = t.h.category('Entertainment & eat-out / Restaurants').id;
    const [split] = await db
      .select({ id: schema.transactionSplit.id })
      .from(schema.transactionSplit)
      .where(eq(schema.transactionSplit.transactionId, (await J11()).id));
    await updateSplitCategory(t.ctx, split.id, restaurants);

    const female = t.h.account('CBA Female').id;
    expect(await previewTransferRedetect(t.ctx, female, femaleValues(t, '0003'))).toEqual({
      count: 0,
      keptCount: 1,
    });
    expect(await updateAccount(t.ctx, female, femaleValues(t, '0003'), { redetect: true })).toEqual(
      { redetectedCount: 0, pairedCount: 0 },
    );
    expect(await J11()).toMatchObject({
      transferStatus: 'none',
      categoryId: restaurants,
      categorySource: 'manual',
    });
  });

  it('R6.4: creating a new account with a suffix also checks (#18 ****9999)', async () => {
    const values: AccountValues = {
      name: 'Other Bank',
      bank: 'other',
      type: 'everyday',
      defaultMemberId: t.h.member('Male').id,
      numberSuffix: '9999',
    };
    expect(await previewTransferRedetect(t.ctx, null, values)).toEqual({ count: 1, keptCount: 0 });
    expect(await createAccount(t.ctx, values, { redetect: true })).toEqual({
      redetectedCount: 1,
      pairedCount: 0,
    });
    expect(await J18()).toMatchObject({
      transferStatus: 'auto',
      categoryId: t.h.systemCategory('internal_transfer').id,
    });
  });

  it("R6.4: another household's transactions are not affected", async () => {
    // household_user.user_id 唯一：先把 t 的关联删掉，才能给同一个测试用户再建一个家庭
    await db.delete(schema.householdUser).where(eq(schema.householdUser.userId, TEST_USER.id));
    const other = await createTestHousehold();
    await clearFemaleSuffix(other);
    await importFixture(other, 'ANZ Joint', 'anz/joint-2026-09.csv');

    const female = t.h.account('CBA Female').id;
    expect(await updateAccount(t.ctx, female, femaleValues(t, '0003'), { redetect: true })).toEqual(
      { redetectedCount: 1, pairedCount: 0 },
    );

    await expectJ11Uncategorised(other);
    expect(await suffixOf(other.h.account('CBA Female').id)).toBeNull();
    // 本家庭的照常改了
    expect((await getTransaction((await J11()).id)).transferStatus).toBe('auto');
  });
});
