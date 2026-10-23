// pnpm db:seed --email you@example.com [--household "My Family"]
// 按 src/lib/seed/data.ts 创建 household、member、category、category_rule，并把用户加进 household_user
// 幂等：全部 ON CONFLICT DO NOTHING，靠 M1-1 的唯一约束跳过已存在的行；已存在的行不更新
// 不创建账户和卡（真实尾号不进代码）
import { parseArgs } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, pool } from '../src/db/index.ts';
import {
  category,
  categoryRule,
  household,
  householdUser,
  member,
  user,
} from '../src/db/schema.ts';
import {
  SEED_CATEGORIES,
  SEED_MEMBERS,
  SEED_RULE_DEFAULTS,
  SEED_RULES,
  SEED_SYSTEM_CATEGORIES,
} from '../src/lib/seed/data.ts';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    household: { type: 'string' },
  },
});

const input = z
  .object({
    email: z.email('email 格式不对').transform((v) => v.toLowerCase()),
    household: z.string().trim().min(1).default('My Family'),
  })
  .safeParse(values);

if (!input.success) {
  console.error('参数错误:', z.prettifyError(input.error));
  console.error('用法: pnpm db:seed --email a@b.com [--household "My Family"]');
  process.exit(1);
}

const { email, household: householdName } = input.data;

type Counts = Record<string, { inserted: number; total: number }>;

try {
  const counts = await db.transaction(async (tx) => {
    const counts: Counts = {};

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
      .onConflictDoNothing()
      .returning({ id: category.id });

    const loadCategories = () =>
      tx
        .select({ id: category.id, parentId: category.parentId, nameEn: category.nameEn })
        .from(category)
        .where(eq(category.householdId, householdId));

    const tops = (await loadCategories()).filter((c) => c.parentId === null);
    const topId = new Map(tops.map((c) => [c.nameEn, c.id]));
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
      .onConflictDoNothing()
      .returning({ id: category.id });

    const allCategories = await loadCategories();
    const topName = new Map(tops.map((c) => [c.id, c.nameEn]));
    const pathId = new Map(
      allCategories
        .filter((c) => c.parentId !== null)
        .map((c) => [`${topName.get(c.parentId!)}/${c.nameEn}`, c.id]),
    );
    counts.category = {
      inserted: insertedTops.length + insertedChildren.length,
      total: allCategories.length,
    };

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
      .onConflictDoNothing()
      .returning({ id: categoryRule.id });

    const ruleTotal = await tx.$count(categoryRule, eq(categoryRule.householdId, householdId));
    const systemRuleTotal = await tx.$count(
      categoryRule,
      and(eq(categoryRule.householdId, householdId), eq(categoryRule.isSystem, true)),
    );
    counts.category_rule = { inserted: insertedRules.length, total: ruleTotal };
    counts['category_rule (is_system)'] = {
      inserted: insertedRules.length,
      total: systemRuleTotal,
    };

    return counts;
  });

  console.log(`seed 完成（${email}）`);
  console.table(counts);
} catch (error) {
  console.error('seed 失败，已回滚:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
