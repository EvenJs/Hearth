// M3-2 示例：在 test 库里建出 fixtures/README.md 的测试家庭
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import { card, category, categoryRule, household, member } from '@/db/schema';
import { listAccounts } from '@/server/accounts';
import { listMembers } from '@/server/members';
import { buildTestHousehold } from '../helpers/household';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';

describeDb('M3-2 test household in the database（fixtures/README.md 测试用的家庭配置）', () => {
  let t: DbTestHousehold;

  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('lists the 5 documented accounts through src/server', async () => {
    const accounts = await listAccounts(t.ctx);
    expect(
      accounts.map((a) => [a.name, a.bank, a.type, a.defaultMemberName, a.numberSuffix]),
    ).toEqual([
      ['ANZ Joint', 'anz', 'joint', 'Home', '0001'],
      ['ANZ Male', 'anz', 'everyday', 'Male', '0002'],
      ['CBA Female', 'cba', 'everyday', 'Female', '0003'],
      ['CBA Female Saver', 'cba', 'savings', 'Female', '7777'],
      ['ANZ Plus Male', 'anz_plus', 'savings', 'Male', '0004'],
    ]);
    expect(accounts.map((a) => a.id)).toEqual(t.h.accounts.map((a) => a.id));
  });

  it('has 3 members, 2 cards on ANZ Joint, and the seed categories and rules', async () => {
    const members = await listMembers(t.ctx);
    expect(members.map((m) => [m.name, m.kind])).toEqual([
      ['Male', 'person'],
      ['Female', 'person'],
      ['Home', 'shared'],
    ]);

    const cards = await db
      .select({ accountId: card.accountId, last4: card.last4, memberId: card.memberId })
      .from(card)
      .where(eq(card.householdId, t.ctx.householdId));
    expect(cards).toEqual([
      { accountId: t.h.account('ANZ Joint').id, last4: '1111', memberId: t.h.member('Male').id },
      { accountId: t.h.account('ANZ Joint').id, last4: '2222', memberId: t.h.member('Female').id },
    ]);

    const mem = buildTestHousehold();
    expect(await db.$count(category, eq(category.householdId, t.ctx.householdId))).toBe(
      mem.categories.length,
    );
    expect(await db.$count(categoryRule, eq(categoryRule.householdId, t.ctx.householdId))).toBe(
      mem.rules.length,
    );
  });

  it('keeps category default members (Groceries → Home) in the database', async () => {
    const [groceries] = await db
      .select({ defaultMemberId: category.defaultMemberId })
      .from(category)
      .where(eq(category.id, t.h.category('Groceries').id));
    expect(groceries.defaultMemberId).toBe(t.h.member('Home').id);
  });

  it('resets business tables before each test: only one household exists', async () => {
    expect(await db.$count(household)).toBe(1);
    expect(await db.$count(member)).toBe(3);
  });
});
