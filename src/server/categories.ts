// 分类查询。两级结构：一级（parent_id 为空）+ 二级；系统分类是没有二级的一级
// 设置 → 分类（M6.5-6，R19）：列表、新建、修改、归档、取消归档
// 判断都在 src/lib/rules/category-admin.ts，这里负责读、写、事务
import { and, asc, count, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { category, categoryRule, member, transactionSplit } from '@/db/schema';
import {
  checkCategoryEdit,
  checkNewCategory,
  planArchive,
  planUnarchive,
  type AdminCategory,
} from '@/lib/rules/category-admin';
import type { HouseholdContext } from './context';
import type { DbTx } from './transactions';

export type CategoryKind = 'expense' | 'income' | 'system';
export type SystemCategoryKey =
  'internal_transfer' | 'cash_withdrawal' | 'bank_fee' | 'uncategorized';

export type Subcategory = {
  id: string;
  nameEn: string;
  nameZh: string | null;
  isPreTaxDefault: boolean;
  isOther: boolean;
  // includeArchived 时才可能是 true。一级归档了，二级也标 true（R16.3）
  isArchived: boolean;
};

export type TopCategory = {
  id: string;
  nameEn: string;
  nameZh: string | null;
  kind: CategoryKind;
  systemKey: SystemCategoryKey | null;
  defaultMemberId: string | null;
  isArchived: boolean; // includeArchived 时才可能是 true
  children: Subcategory[];
};

export type CategoryTreeOptions = {
  // F8 分类筛选用（R19.4）：带上归档的，标 isArchived。默认 false：
  // 改分类、拆分、快速录入、规则的下拉都看不到归档的（R16.3）
  includeArchived?: boolean;
};

// 列出分类树，一级和二级都按 sort_order 排
// 默认只有未归档的；一级归档后，它下面的二级也不出现
export async function listCategoryTree(
  ctx: HouseholdContext,
  options: CategoryTreeOptions = {},
): Promise<TopCategory[]> {
  const where: SQL[] = [eq(category.householdId, ctx.householdId)];
  if (!options.includeArchived) where.push(eq(category.isArchived, false));

  const rows = await db
    .select({
      id: category.id,
      parentId: category.parentId,
      nameEn: category.nameEn,
      nameZh: category.nameZh,
      kind: category.kind,
      systemKey: category.systemKey,
      defaultMemberId: category.defaultMemberId,
      isPreTaxDefault: category.isPreTaxDefault,
      isOther: category.isOther,
      isArchived: category.isArchived,
    })
    .from(category)
    .where(and(...where))
    .orderBy(asc(category.sortOrder), asc(category.nameEn));

  const tops = new Map<string, TopCategory>();
  for (const r of rows) {
    if (r.parentId === null) {
      tops.set(r.id, {
        id: r.id,
        nameEn: r.nameEn,
        nameZh: r.nameZh,
        kind: r.kind,
        systemKey: r.systemKey,
        defaultMemberId: r.defaultMemberId,
        isArchived: r.isArchived,
        children: [],
      });
    }
  }
  // rows 已经按 sort_order 排好，按顺序 push 就保持顺序
  for (const r of rows) {
    if (r.parentId === null) continue;
    const top = tops.get(r.parentId);
    top?.children.push({
      id: r.id,
      nameEn: r.nameEn,
      nameZh: r.nameZh,
      isPreTaxDefault: r.isPreTaxDefault,
      isOther: r.isOther,
      isArchived: r.isArchived || top.isArchived,
    });
  }
  return [...tops.values()];
}

// ---------- 设置 → 分类（M6.5-6，R19） ----------

export type AdminCategoryItem = {
  id: string;
  parentId: string | null;
  nameEn: string;
  nameZh: string | null;
  kind: CategoryKind;
  systemKey: SystemCategoryKey | null;
  defaultMemberId: string | null;
  isPreTaxDefault: boolean;
  isOther: boolean;
  sortOrder: number;
  isArchived: boolean; // 自己的标记。二级要看一级归档没有，看 top.isArchived
  // R19.1 用了几笔、几条规则指向它。一级是自己加所有二级的合计
  splitCount: number;
  ruleCount: number;
};

export type AdminTopCategory = AdminCategoryItem & { children: AdminCategoryItem[] };

// R19.1：按支出、收入、系统分组，一级、二级都按 sort_order 排，含归档的（页面决定显不显示）
export type CategoryAdminList = {
  expense: AdminTopCategory[];
  income: AdminTopCategory[];
  system: AdminTopCategory[];
};

export type CategoryWriteResult =
  | { ok: true; categoryId: string }
  | { ok: false; reason: 'invalid' | 'not_found'; message: string };

export type ArchiveResult =
  | { ok: true; ids: string[] }
  | { ok: false; reason: 'invalid' | 'not_found'; message: string }
  // R19.4：有规则指向。ruleFilterTopId：规则页链接带的一级筛选
  | { ok: false; reason: 'has_rules'; message: string; ruleCount: number; ruleFilterTopId: string };

const CATEGORY_NOT_FOUND = { ok: false, reason: 'not_found', message: '分类不存在' } as const;

// 全部分类（含归档），按 sort_order 排。传 tx 时在同一个事务里读
async function loadAdminCategories(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
): Promise<(AdminCategory & { nameZh: string | null })[]> {
  return tx
    .select({
      id: category.id,
      parentId: category.parentId,
      nameEn: category.nameEn,
      nameZh: category.nameZh,
      kind: category.kind,
      systemKey: category.systemKey,
      defaultMemberId: category.defaultMemberId,
      isPreTaxDefault: category.isPreTaxDefault,
      isOther: category.isOther,
      sortOrder: category.sortOrder,
      isArchived: category.isArchived,
    })
    .from(category)
    .where(eq(category.householdId, ctx.householdId))
    .orderBy(asc(category.sortOrder), asc(category.nameEn));
}

// 分类 id → 指向它的规则条数
async function loadRuleCounts(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({ categoryId: categoryRule.categoryId, n: count() })
    .from(categoryRule)
    .where(eq(categoryRule.householdId, ctx.householdId))
    .groupBy(categoryRule.categoryId);
  return new Map(rows.map((r) => [r.categoryId, r.n]));
}

// 分类 id → 拆分数
async function loadSplitCounts(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({ categoryId: transactionSplit.categoryId, n: count() })
    .from(transactionSplit)
    .where(eq(transactionSplit.householdId, ctx.householdId))
    .groupBy(transactionSplit.categoryId);
  return new Map(rows.map((r) => [r.categoryId, r.n]));
}

// 默认归属人要属于本家庭、没归档（防止表单被改成别家的 member id）
async function isActiveMemberTx(tx: DbTx, ctx: HouseholdContext, memberId: string) {
  const [m] = await tx
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.id, memberId),
        eq(member.householdId, ctx.householdId),
        eq(member.isArchived, false),
      ),
    );
  return m !== undefined;
}

// R19.1 列表
export async function listCategoriesForAdmin(ctx: HouseholdContext): Promise<CategoryAdminList> {
  return db.transaction(
    async (tx) => {
      const [rows, ruleCounts, splitCounts] = await Promise.all([
        loadAdminCategories(tx, ctx),
        loadRuleCounts(tx, ctx),
        loadSplitCounts(tx, ctx),
      ]);

      const item = (c: (typeof rows)[number]): AdminCategoryItem => ({
        id: c.id,
        parentId: c.parentId,
        nameEn: c.nameEn,
        nameZh: c.nameZh,
        kind: c.kind,
        systemKey: c.systemKey,
        defaultMemberId: c.defaultMemberId,
        isPreTaxDefault: c.isPreTaxDefault,
        isOther: c.isOther,
        sortOrder: c.sortOrder,
        isArchived: c.isArchived,
        splitCount: splitCounts.get(c.id) ?? 0,
        ruleCount: ruleCounts.get(c.id) ?? 0,
      });

      const tops = new Map<string, AdminTopCategory>();
      for (const c of rows) if (c.parentId === null) tops.set(c.id, { ...item(c), children: [] });
      // rows 已经按 sort_order 排好，按顺序 push 就保持顺序
      for (const c of rows) {
        if (c.parentId === null) continue;
        const top = tops.get(c.parentId);
        if (!top) continue;
        const child = item(c);
        top.children.push(child);
        top.splitCount += child.splitCount;
        top.ruleCount += child.ruleCount;
      }

      const list: CategoryAdminList = { expense: [], income: [], system: [] };
      for (const top of tops.values()) list[top.kind].push(top);
      return list;
    },
    { accessMode: 'read only' },
  );
}

const memberIdSchema = z.uuid().nullable().optional();

const createSchema = z.object({
  nameEn: z.string(),
  parentId: z.uuid().nullable(),
  kind: z.enum(['expense', 'income']).optional(),
  defaultMemberId: memberIdSchema,
  isPreTaxDefault: z.boolean().optional(),
});

export type CreateCategoryInput = z.input<typeof createSchema>;

const updateSchema = z.object({
  nameEn: z.string().optional(),
  defaultMemberId: memberIdSchema,
  isPreTaxDefault: z.boolean().optional(),
  // 表单可能整条传回来；和原来不一样时 checkCategoryEdit 报错（R19.3）
  kind: z.enum(['expense', 'income', 'system']).optional(),
  parentId: z.uuid().nullable().optional(),
});

export type UpdateCategoryInput = z.input<typeof updateSchema>;

// 唯一约束 (household_id, parent_id, name_en)：两次保存同时撞上时的兜底。drizzle 把驱动错误包在 cause 里
// 平时 checkNewCategory 已经按不区分大小写查过了
function isCategoryNameUniqueViolation(err: unknown): boolean {
  const pgError = (err as { cause?: unknown })?.cause ?? err;
  const { code, constraint } = (pgError ?? {}) as { code?: string; constraint?: string };
  return code === '23505' && constraint === 'category_household_id_parent_id_name_en_unique';
}

async function withNameConflictFallback(
  write: () => Promise<CategoryWriteResult>,
): Promise<CategoryWriteResult> {
  try {
    return await write();
  } catch (err) {
    if (!isCategoryNameUniqueViolation(err)) throw err;
    return { ok: false, reason: 'invalid', message: '已有同名的分类' };
  }
}

// R19.2 新建：一个事务。一级同时建 Other；二级插在 Other 前面，Other 往后挪
export async function createCategory(
  ctx: HouseholdContext,
  input: CreateCategoryInput,
): Promise<CategoryWriteResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid', message: '输入不对' };
  const data = parsed.data;

  return withNameConflictFallback(() =>
    db.transaction(async (tx): Promise<CategoryWriteResult> => {
      const categories = await loadAdminCategories(tx, ctx);
      const r = checkNewCategory(data, categories);
      if (!r.ok) return { ok: false, reason: 'invalid', message: r.message };
      const { category: row, other, moveOther } = r.value;

      if (row.defaultMemberId && !(await isActiveMemberTx(tx, ctx, row.defaultMemberId))) {
        return { ok: false, reason: 'invalid', message: '请选择默认归属人' };
      }

      const [created] = await tx
        .insert(category)
        .values({ householdId: ctx.householdId, ...row })
        .returning({ id: category.id });

      if (other) {
        await tx
          .insert(category)
          .values({ householdId: ctx.householdId, parentId: created.id, ...other });
      }
      if (moveOther) {
        await tx
          .update(category)
          .set({ sortOrder: moveOther.sortOrder })
          .where(and(eq(category.id, moveOther.id), eq(category.householdId, ctx.householdId)));
      }
      return { ok: true, categoryId: created.id };
    }),
  );
}

// R19.3 修改：名字、默认归属人、税前。改默认归属人、税前只影响以后，不重算已有交易
export async function updateCategory(
  ctx: HouseholdContext,
  categoryId: string,
  input: UpdateCategoryInput,
): Promise<CategoryWriteResult> {
  if (!z.uuid().safeParse(categoryId).success) return CATEGORY_NOT_FOUND;
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid', message: '输入不对' };

  return withNameConflictFallback(() =>
    db.transaction(async (tx): Promise<CategoryWriteResult> => {
      const categories = await loadAdminCategories(tx, ctx);
      const target = categories.find((c) => c.id === categoryId);
      if (!target) return CATEGORY_NOT_FOUND;

      const r = checkCategoryEdit(target, parsed.data, categories);
      if (!r.ok) return { ok: false, reason: 'invalid', message: r.message };
      const patch = r.value;

      // 只在换了归属人时检查，原来的值（哪怕后来归档了）原样传回来不报错
      if (
        patch.defaultMemberId &&
        patch.defaultMemberId !== target.defaultMemberId &&
        !(await isActiveMemberTx(tx, ctx, patch.defaultMemberId))
      ) {
        return { ok: false, reason: 'invalid', message: '请选择默认归属人' };
      }

      if (Object.keys(patch).length > 0) {
        await tx
          .update(category)
          .set(patch)
          .where(and(eq(category.id, categoryId), eq(category.householdId, ctx.householdId)));
      }
      return { ok: true, categoryId };
    }),
  );
}

async function setArchived(tx: DbTx, ctx: HouseholdContext, ids: string[], archived: boolean) {
  await tx
    .update(category)
    .set({ isArchived: archived })
    .where(and(eq(category.householdId, ctx.householdId), inArray(category.id, ids)));
}

// R19.4 归档：一级带上所有二级；有规则指向（一级包括二级）就不归档，什么都不改
// 已有交易不动，统计照常算
export async function archiveCategory(
  ctx: HouseholdContext,
  categoryId: string,
): Promise<ArchiveResult> {
  if (!z.uuid().safeParse(categoryId).success) return CATEGORY_NOT_FOUND;

  return db.transaction(async (tx): Promise<ArchiveResult> => {
    const [categories, ruleCounts] = await Promise.all([
      loadAdminCategories(tx, ctx),
      loadRuleCounts(tx, ctx),
    ]);
    const p = planArchive(categoryId, categories, ruleCounts);
    if (!p.ok) {
      if (p.reason === 'not_found') return CATEGORY_NOT_FOUND;
      if (p.reason === 'has_rules') {
        return {
          ok: false,
          reason: 'has_rules',
          message: p.message,
          ruleCount: p.ruleCount!,
          ruleFilterTopId: p.ruleFilterTopId!,
        };
      }
      return { ok: false, reason: 'invalid', message: p.message };
    }
    await setArchived(tx, ctx, p.ids, true);
    return { ok: true, ids: p.ids };
  });
}

// R19.4 取消归档：一级带上所有二级；二级的一级还在归档中时报错
export async function unarchiveCategory(
  ctx: HouseholdContext,
  categoryId: string,
): Promise<ArchiveResult> {
  if (!z.uuid().safeParse(categoryId).success) return CATEGORY_NOT_FOUND;

  return db.transaction(async (tx): Promise<ArchiveResult> => {
    const categories = await loadAdminCategories(tx, ctx);
    if (!categories.some((c) => c.id === categoryId)) return CATEGORY_NOT_FOUND;
    const p = planUnarchive(categoryId, categories);
    if (!p.ok) return { ok: false, reason: 'invalid', message: p.message };
    await setArchived(tx, ctx, p.ids, false);
    return { ok: true, ids: p.ids };
  });
}
