// M3-2 集成测试 helper：清空业务表、建 fixtures/README.md 的测试家庭
// 只在 tests/integration/ 里用。连的是 TEST_DATABASE_URL（见 setup/test-db-env.ts）
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { HouseholdContext } from '@/server/context';
import { buildTestHousehold, type TestHousehold } from '../../helpers/household';

// 没设 TEST_DATABASE_URL 时整组跳过
export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);
export const describeDb = describe.skipIf(!hasTestDb);

// Better Auth 的表不清，测试用户靠 upsert
const AUTH_TABLES = new Set(['user', 'session', 'account', 'verification']);

// 业务表 = schema 里除了 auth 以外的所有表，以后加新表自动包含
const BUSINESS_TABLES = Object.values(schema as Record<string, unknown>)
  .filter((v): v is PgTable => is(v, PgTable))
  .map((t): string => getTableName(t))
  .filter((name) => !AUTH_TABLES.has(name));

export async function resetBusinessTables(): Promise<void> {
  const list = BUSINESS_TABLES.map((t) => `"${t}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
}

export const TEST_USER = {
  id: 'integration-test-user',
  name: 'Integration Test',
  email: 'integration@hearth.test',
} as const;

const ACCOUNTS_CREATED_AT = Date.UTC(2026, 0, 1);

export type DbTestHousehold = { ctx: HouseholdContext; h: TestHousehold };

// 按 buildTestHousehold() 的内存对象写进数据库，返回同一个形状、换成真 uuid 的 TestHousehold
// 这样单元测试和集成测试用同一份家庭配置
export async function createTestHousehold(): Promise<DbTestHousehold> {
  const mem = buildTestHousehold();
  // 假 id（'member:Male'）→ 数据库 uuid
  const ids = new Map<string, string>();
  const real = (fakeId: string) => {
    const id = ids.get(fakeId);
    if (!id) throw new Error(`测试家庭里 ${fakeId} 还没写进数据库`);
    return id;
  };
  const realOrNull = (fakeId: string | null) => (fakeId === null ? null : real(fakeId));

  const householdId = await db.transaction(async (tx) => {
    await tx
      .insert(schema.user)
      .values({ ...TEST_USER, emailVerified: true })
      .onConflictDoNothing({ target: schema.user.id });

    const [hh] = await tx
      .insert(schema.household)
      .values({ name: 'Test Household' })
      .returning({ id: schema.household.id });
    const householdId = hh.id;

    const members = await tx
      .insert(schema.member)
      .values(
        mem.members.map((m, i) => ({ householdId, name: m.name, kind: m.kind, sortOrder: i })),
      )
      .returning({ id: schema.member.id });
    mem.members.forEach((m, i) => ids.set(m.id, members[i].id));

    await tx.insert(schema.householdUser).values({
      householdId,
      userId: TEST_USER.id,
      memberId: real(mem.member('Male').id),
    });

    const accounts = await tx
      .insert(schema.financialAccount)
      .values(
        mem.accounts.map((a, i) => ({
          householdId,
          // 真实情况是一个一个建的。一条 INSERT 的 created_at 全一样，listAccounts 会退回按名字排
          // 按 fixtures/README.md 的顺序每个加 1 秒，排序才确定
          createdAt: new Date(ACCOUNTS_CREATED_AT + i * 1000),
          name: a.name,
          bank: a.bank,
          type: a.type,
          defaultMemberId: real(a.defaultMemberId),
          numberSuffix: a.numberSuffix,
        })),
      )
      .returning({ id: schema.financialAccount.id });
    mem.accounts.forEach((a, i) => ids.set(a.id, accounts[i].id));

    const cards = await tx
      .insert(schema.card)
      .values(
        mem.cards.map((c) => ({
          householdId,
          accountId: real(c.accountId),
          last4: c.last4,
          memberId: real(c.memberId),
        })),
      )
      .returning({ id: schema.card.id });
    mem.cards.forEach((c, i) => ids.set(c.id, cards[i].id));

    // 先一级（含系统分类），再二级（parent_id 要真 id）
    for (const level of [
      mem.categories.filter((c) => c.parentId === null),
      mem.categories.filter((c) => c.parentId !== null),
    ]) {
      const rows = await tx
        .insert(schema.category)
        .values(
          level.map((c, i) => ({
            householdId,
            parentId: realOrNull(c.parentId),
            nameEn: c.nameEn,
            kind: c.kind,
            systemKey: c.systemKey,
            defaultMemberId: realOrNull(c.defaultMemberId),
            isPreTaxDefault: c.isPreTaxDefault,
            isOther: c.isOther,
            sortOrder: i,
          })),
        )
        .returning({ id: schema.category.id });
      level.forEach((c, i) => ids.set(c.id, rows[i].id));
    }

    const rules = await tx
      .insert(schema.categoryRule)
      .values(
        mem.rules.map((r) => ({
          householdId,
          keyword: r.keyword,
          matchType: r.matchType,
          categoryId: real(r.categoryId),
          priority: r.priority,
          isSystem: r.isSystem,
          createdAt: r.createdAt,
        })),
      )
      .returning({ id: schema.categoryRule.id });
    mem.rules.forEach((r, i) => ids.set(r.id, rules[i].id));

    return householdId;
  });

  // ---------- 换成真 id 的 TestHousehold ----------
  const mapMember = (m: TestHousehold['members'][number]) => ({ ...m, id: real(m.id) });
  const mapAccount = (a: TestHousehold['accounts'][number]) => ({
    ...a,
    id: real(a.id),
    defaultMemberId: real(a.defaultMemberId),
  });
  const mapCategory = (c: TestHousehold['categories'][number]) => ({
    ...c,
    id: real(c.id),
    parentId: realOrNull(c.parentId),
    defaultMemberId: realOrNull(c.defaultMemberId),
  });

  const h: TestHousehold = {
    members: mem.members.map(mapMember),
    accounts: mem.accounts.map(mapAccount),
    cards: mem.cards.map((c) => ({
      ...c,
      id: real(c.id),
      accountId: real(c.accountId),
      memberId: real(c.memberId),
    })),
    categories: mem.categories.map(mapCategory),
    rules: mem.rules.map((r) => ({ ...r, id: real(r.id), categoryId: real(r.categoryId) })),
    member: (name) => mapMember(mem.member(name)),
    account: (name) => mapAccount(mem.account(name)),
    category: (path) => mapCategory(mem.category(path)),
    systemCategory: (key) => mapCategory(mem.systemCategory(key)),
  };

  const ctx: HouseholdContext = {
    userId: TEST_USER.id,
    householdId,
    memberId: real(mem.member('Male').id),
  };

  return { ctx, h };
}
