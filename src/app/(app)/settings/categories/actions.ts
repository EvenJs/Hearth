'use server';

// 设置 → 分类的 Server Actions（M6.5-7，R19）。输入在这里用 Zod 再校验一次（前端校验可以被绕过）
// 名字规范化、重名、能不能改、能不能归档在 src/server/categories.ts（M6.5-5 的函数）里判断
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  archiveCategory,
  createCategory,
  unarchiveCategory,
  updateCategory,
  type ArchiveResult,
  type CategoryWriteResult,
} from '@/server/categories';
import { getHouseholdContext } from '@/server/context';

const createSchema = z.object({
  nameEn: z.string().max(1000),
  parentId: z.uuid().nullable(),
  kind: z.enum(['expense', 'income']).optional(),
  defaultMemberId: z.uuid().nullable(),
  isPreTaxDefault: z.boolean(),
});
const updateSchema = z.object({
  nameEn: z.string().max(1000).optional(), // Other 不传
  defaultMemberId: z.uuid().nullable(),
  isPreTaxDefault: z.boolean().optional(), // 只有收入的二级传
});
const idSchema = z.uuid();

export type CreateCategoryActionInput = z.infer<typeof createSchema>;
export type UpdateCategoryActionInput = z.infer<typeof updateSchema>;

const INVALID = { ok: false, reason: 'invalid', message: '请检查输入' } as const;
const FAILED = { ok: false, reason: 'invalid', message: '保存失败，请稍后再试' } as const;

async function run<T extends CategoryWriteResult | ArchiveResult>(
  what: string,
  write: () => Promise<T>,
): Promise<T | typeof FAILED> {
  try {
    const r = await write();
    // 分类出现在流水、快速录入、规则的下拉和看板里，整个 app 都要刷新
    if (r.ok) revalidatePath('/', 'layout');
    return r;
  } catch (err) {
    // 不打印错误内容，免得把分类名之类的数据写进日志
    console.error(`[categories] ${what}失败`, err instanceof Error ? err.name : typeof err);
    return FAILED;
  }
}

export async function createCategoryAction(
  input: CreateCategoryActionInput,
): Promise<CategoryWriteResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  return run('新建分类', () => createCategory(ctx, parsed.data));
}

export async function updateCategoryAction(
  categoryId: string,
  input: UpdateCategoryActionInput,
): Promise<CategoryWriteResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success || !idSchema.safeParse(categoryId).success) return INVALID;
  const ctx = await getHouseholdContext();
  return run('修改分类', () => updateCategory(ctx, categoryId, parsed.data));
}

export async function archiveCategoryAction(categoryId: string): Promise<ArchiveResult> {
  if (!idSchema.safeParse(categoryId).success) return INVALID;
  const ctx = await getHouseholdContext();
  return run('归档分类', () => archiveCategory(ctx, categoryId));
}

export async function unarchiveCategoryAction(categoryId: string): Promise<ArchiveResult> {
  if (!idSchema.safeParse(categoryId).success) return INVALID;
  const ctx = await getHouseholdContext();
  return run('取消归档分类', () => unarchiveCategory(ctx, categoryId));
}
