// pnpm db:seed 的主体（scripts/seed.ts 只解析参数、打印结果）
// 按 src/lib/seed/data.ts 创建 household、member、category、category_rule，并把用户加进 household_user
// R18.5、R19.5：分类和预置规则只在本家庭还没有分类时插（第一次 seed）。之后再跑只补 member、
// household_user，不碰 category、category_rule，管理页里删掉或改过的不会被加回来
// member 幂等：ON CONFLICT DO NOTHING，靠 M1-1 的唯一约束跳过已存在的行；已存在的行不更新
// 不创建账户和卡（真实尾号不进代码）
// scripts/ 用 node 直接跑，不认 @/ 路径别名，所以这里用相对路径 + .ts 后缀
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { category, categoryRule, household, householdUser, member, user } from '../db/schema.ts';
import {
  SEED_CATEGORIES,
  SEED_MEMBERS,
  SEED_RULE_DEFAULTS,
  SEED_RULES,
  SEED_SYSTEM_CATEGORIES,
} from '../lib/seed/data.ts';

export type SeedCounts = Record<string, { inserted: number; total: number }>;

export type SeedResult = {
  householdId: string;
  counts: SeedCounts;
  // true：本家庭已经有分类，分类和规则两段跳过了（R19.5）
  catalogSkipped: boolean;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function seedHousehold(input: {
  email: string;
  householdName: string;
}): Promise<SeedResult> {
  const { email, householdName } = input;

  return db.transaction(async (tx) => {
    const counts: SeedCounts = {};

    // ---------- 用户 ----------
    const [u] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (!u) throw new Error(`用户不存在: ${email}（先跑 pnpm user:create）`);

    // ---------- household ----------
    // household 没有唯一名字，用 household_user 判断：用户已经有家庭就沿用
    const [link] = await tx
      .select({ householdId: householdUser.householdId })
      .from(householdUser)
      .where(eq(householdUser.userId, u.id));

    let householdId: string;
    if (link) {
      householdId = link.householdId;
      counts.household = { inserted: 0, total: 1 };
    } else {
      const [h] = await tx
        .insert(household)
        .values({ name: householdName })
        .returning({ id: household.id });
      householdId = h.id;
      counts.household = { inserted: 1, total: 1 };
    }

    // ---------- member ----------
    const insertedMembers = await tx
      .insert(member)
      .values(
        SEED_MEMBERS.map((m, i) => ({ householdId, name: m.name, kind: m.kind, sortOrder: i })),
      )
      .onConflictDoNothing()
      .returning({ id: member.id });

    const memberRows = await tx
      .select({ id: member.id, name: member.name })
      .from(member)
      .where(eq(member.householdId, householdId));
    const memberId = new Map(memberRows.map((m) => [m.name, m.id]));
    counts.member = { inserted: insertedMembers.length, total: memberRows.length };

    const requireMember = (name: string) => {
      const id = memberId.get(name);
      if (!id) throw new Error(`找不到归属人: ${name}`);
      return id;
    };

    // ---------- household_user ----------
    // 已经有关联就不改（包括 member_id）
    if (!link) {
      await tx
        .insert(householdUser)
        .values({ householdId, userId: u.id, memberId: requireMember('Male') });
    }

    // ---------- category、category_rule ----------
    // R18.5、R19.5：只看有没有分类。分类在、规则删光了也跳过
    const existingCategories = await tx.$count(category, eq(category.householdId, householdId));
    if (existingCategories > 0) {
      const ruleTotal = await tx.$count(categoryRule, eq(categoryRule.householdId, householdId));
      counts.category = { inserted: 0, total: existingCategories };
      counts.category_rule = { inserted: 0, total: ruleTotal };
      return { householdId, counts, catalogSkipped: true };
    }

    await seedCatalog(tx, householdId, requireMember, counts);
    return { householdId, counts, catalogSkipped: false };
  });
}

// 第一次 seed：分类（一级 + 系统分类 + 二级含 Other）和预置规则
async function seedCatalog(
  tx: Tx,
  householdId: string,
  requireMember: (name: string) => string,
  counts: SeedCounts,
): Promise<void> {
  // ---------- category：一级 + 系统分类 ----------
  const topValues = [
    ...SEED_CATEGORIES.map((c, i) => ({
      householdId,
      nameEn: c.nameEn,
      kind: c.kind,
      defaultMemberId: c.defaultMember ? requireMember(c.defaultMember) : null,
      sortOrder: i,
    })),
    ...SEED_SYSTEM_CATEGORIES.map((s, i) => ({
      householdId,
      nameEn: s.nameEn,
      kind: 'system' as const,
      systemKey: s.systemKey,
      sortOrder: SEED_CATEGORIES.length + i,
    })),
  ];
  const insertedTops = await tx
    .insert(category)
    .values(topValues)
    .returning({ id: category.id, nameEn: category.nameEn });
  const topId = new Map(insertedTops.map((c) => [c.nameEn, c.id]));
  const requireTop = (name: string) => {
    const id = topId.get(name);
    if (!id) throw new Error(`找不到一级分类: ${name}`);
    return id;
  };

  // ---------- category：二级（含 Other） ----------
  // 默认归属人只设在一级，二级为空时继承（R5）
  const childValues = SEED_CATEGORIES.flatMap((c) =>
    c.children.map((ch, i) => ({
      householdId,
      parentId: requireTop(c.nameEn),
      nameEn: ch.nameEn,
      kind: c.kind,
      isPreTaxDefault: ch.isPreTaxDefault,
      isOther: ch.isOther,
      sortOrder: i,
    })),
  );
  const insertedChildren = await tx
    .insert(category)
    .values(childValues)
    .returning({ id: category.id, parentId: category.parentId, nameEn: category.nameEn });

  const topName = new Map(insertedTops.map((c) => [c.id, c.nameEn]));
  const pathId = new Map(
    insertedChildren.map((c) => [`${topName.get(c.parentId!)}/${c.nameEn}`, c.id]),
  );
  const categoryTotal = insertedTops.length + insertedChildren.length;
  counts.category = { inserted: categoryTotal, total: categoryTotal };

  // ---------- category_rule ----------
  const ruleValues = SEED_RULES.map((r) => {
    const categoryId = pathId.get(`${r.category}/${r.subcategory}`);
    if (!categoryId)
      throw new Error(`规则 ${r.keyword} 找不到分类: ${r.category}/${r.subcategory}`);
    return { householdId, keyword: r.keyword, categoryId, ...SEED_RULE_DEFAULTS };
  });
  const insertedRules = await tx
    .insert(categoryRule)
    .values(ruleValues)
    .returning({ id: categoryRule.id });

  const systemRuleTotal = await tx.$count(
    categoryRule,
    and(eq(categoryRule.householdId, householdId), eq(categoryRule.isSystem, true)),
  );
  counts.category_rule = { inserted: insertedRules.length, total: insertedRules.length };
  counts['category_rule (is_system)'] = { inserted: insertedRules.length, total: systemRuleTotal };
}
