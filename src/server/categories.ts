// 分类查询。两级结构：一级（parent_id 为空）+ 二级；系统分类是没有二级的一级
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { category } from '@/db/schema';
import type { HouseholdContext } from './context';

export type CategoryKind = 'expense' | 'income' | 'system';
export type SystemCategoryKey =
  | 'internal_transfer'
  | 'cash_withdrawal'
  | 'bank_fee'
  | 'uncategorized';

export type Subcategory = {
  id: string;
  nameEn: string;
  nameZh: string | null;
  isPreTaxDefault: boolean;
  isOther: boolean;
};

export type TopCategory = {
  id: string;
  nameEn: string;
  nameZh: string | null;
  kind: CategoryKind;
  systemKey: SystemCategoryKey | null;
  defaultMemberId: string | null;
  children: Subcategory[];
};

// 列出未归档的分类树，一级和二级都按 sort_order 排
// 一级归档后，它下面的二级也不出现
export async function listCategoryTree(ctx: HouseholdContext): Promise<TopCategory[]> {
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
    })
    .from(category)
    .where(and(eq(category.householdId, ctx.householdId), eq(category.isArchived, false)))
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
        children: [],
      });
    }
  }
  // rows 已经按 sort_order 排好，按顺序 push 就保持顺序
  for (const r of rows) {
    if (r.parentId === null) continue;
    tops.get(r.parentId)?.children.push({
      id: r.id,
      nameEn: r.nameEn,
      nameZh: r.nameZh,
      isPreTaxDefault: r.isPreTaxDefault,
      isOther: r.isOther,
    });
  }
  return [...tops.values()];
}
