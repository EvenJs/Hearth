// M6.5-1 seed 只在第一次插分类和规则（R18.5、R19.5）
// 期望的数量来自 docs/seed-categories.md：一级 7 个支出 + 1 个收入，二级 52 个 + 每个一级一个 Other，
// 系统分类 4 个，共 72 个分类；预置规则 83 条（和 src/lib/seed/data.test.ts 一致）
import { and, eq, isNull } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { seedHousehold } from '@/server/seed';
import { describeDb, resetBusinessTables, TEST_USER } from './helpers/db';

const SEED_CATEGORY_COUNT = 72;
const SEED_RULE_COUNT = 83;

const seed = () => seedHousehold({ email: TEST_USER.email, householdName: 'Seed Test' });

async function countIn(householdId: string) {
  const categories = await db.$count(schema.category, eq(schema.category.householdId, householdId));
  const rules = await db.$count(
    schema.categoryRule,
    eq(schema.categoryRule.householdId, householdId),
  );
  const members = await db.$count(schema.member, eq(schema.member.householdId, householdId));
  const links = await db.$count(
    schema.householdUser,
    eq(schema.householdUser.householdId, householdId),
  );
  return { categories, rules, members, links };
}

describeDb('seedHousehold（R18.5、R19.5）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    await db
      .insert(schema.user)
      .values({ ...TEST_USER, emailVerified: true })
      .onConflictDoNothing({ target: schema.user.id });
  });

  it('R19.5: first seed on an empty household inserts all documented categories and rules', async () => {
    const r = await seed();

    expect(r.catalogSkipped).toBe(false);
    expect(await countIn(r.householdId)).toEqual({
      categories: SEED_CATEGORY_COUNT,
      rules: SEED_RULE_COUNT,
      members: 3,
      links: 1,
    });
    expect(r.counts.category).toEqual({
      inserted: SEED_CATEGORY_COUNT,
      total: SEED_CATEGORY_COUNT,
    });
    expect(r.counts.category_rule).toEqual({ inserted: SEED_RULE_COUNT, total: SEED_RULE_COUNT });
  });

  it('R18.5, R19.5: second seed skips categories and rules; members and household_user stay idempotent', async () => {
    const first = await seed();
    const second = await seed();

    expect(second.householdId).toBe(first.householdId);
    expect(second.catalogSkipped).toBe(true);
    expect(second.counts.member).toEqual({ inserted: 0, total: 3 });
    expect(second.counts.category).toEqual({ inserted: 0, total: SEED_CATEGORY_COUNT });
    expect(second.counts.category_rule).toEqual({ inserted: 0, total: SEED_RULE_COUNT });
    expect(await countIn(first.householdId)).toEqual({
      categories: SEED_CATEGORY_COUNT,
      rules: SEED_RULE_COUNT,
      members: 3,
      links: 1,
    });
  });

  it('R18.5: a deleted preset rule is not added back by a later seed', async () => {
    const { householdId } = await seed();
    const coles = and(
      eq(schema.categoryRule.householdId, householdId),
      eq(schema.categoryRule.keyword, 'COLES'),
    );
    await db.delete(schema.categoryRule).where(coles);

    const r = await seed();

    expect(r.catalogSkipped).toBe(true);
    expect(await db.$count(schema.categoryRule, coles)).toBe(0);
    expect((await countIn(householdId)).rules).toBe(SEED_RULE_COUNT - 1);
  });

  it('R19.5: a renamed preset category is not re-created by a later seed', async () => {
    const { householdId } = await seed();
    const groceries = and(
      eq(schema.category.householdId, householdId),
      isNull(schema.category.parentId),
      eq(schema.category.nameEn, 'Groceries'),
    );
    await db.update(schema.category).set({ nameEn: 'Food shopping' }).where(groceries);

    const r = await seed();

    expect(r.catalogSkipped).toBe(true);
    expect(await db.$count(schema.category, groceries)).toBe(0);
    expect((await countIn(householdId)).categories).toBe(SEED_CATEGORY_COUNT);
  });

  it('R19.5: categories exist but every rule was deleted — still skipped, no rules come back', async () => {
    const { householdId } = await seed();
    await db.delete(schema.categoryRule).where(eq(schema.categoryRule.householdId, householdId));

    const r = await seed();

    expect(r.catalogSkipped).toBe(true);
    expect((await countIn(householdId)).rules).toBe(0);
  });

  it('unknown email fails and writes nothing', async () => {
    await expect(
      seedHousehold({ email: 'nobody@hearth.test', householdName: 'X' }),
    ).rejects.toThrow('用户不存在');
    expect(await db.$count(schema.household)).toBe(0);
  });
});
