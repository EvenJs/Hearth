'use server';

// 设置 → 预算的 Server Actions（M7-2，R11.2、R11.3）。输入在这里用 Zod 再校验一次（前端校验可以被绕过）
// 金额转分、能不能设预算、重复在 src/server/budgets.ts 里判断
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  createBudget,
  deleteBudget,
  setBudgetPinned,
  updateBudget,
  type BudgetWriteResult,
} from '@/server/budgets';
import { getHouseholdContext } from '@/server/context';

const percentSchema = z.number().int().min(1).max(100);
const createSchema = z.object({
  categoryId: z.uuid(),
  monthlyLimit: z.string().max(100),
  warnAtPercent: percentSchema,
  isPinned: z.boolean(),
});
// 没有 categoryId：编辑不能换分类
const updateSchema = z.object({
  monthlyLimit: z.string().max(100),
  warnAtPercent: percentSchema,
  isPinned: z.boolean(),
});
const idSchema = z.uuid();

export type CreateBudgetActionInput = z.infer<typeof createSchema>;
export type UpdateBudgetActionInput = z.infer<typeof updateSchema>;

const INVALID = { ok: false, reason: 'invalid', message: '请检查输入' } as const;
const FAILED = { ok: false, reason: 'invalid', message: '保存失败，请稍后再试' } as const;

async function run(
  what: string,
  write: () => Promise<BudgetWriteResult>,
): Promise<BudgetWriteResult> {
  try {
    const r = await write();
    // 预算出现在设置页和首页置顶条（R11.3）
    if (r.ok) revalidatePath('/', 'layout');
    return r;
  } catch (err) {
    // 不打印错误内容，免得把金额之类的数据写进日志
    console.error(`[budgets] ${what}失败`, err instanceof Error ? err.name : typeof err);
    return FAILED;
  }
}

export async function createBudgetAction(
  input: CreateBudgetActionInput,
): Promise<BudgetWriteResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  return run('新建预算', () => createBudget(ctx, parsed.data));
}

export async function updateBudgetAction(
  budgetId: string,
  input: UpdateBudgetActionInput,
): Promise<BudgetWriteResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success || !idSchema.safeParse(budgetId).success) return INVALID;
  const ctx = await getHouseholdContext();
  return run('修改预算', () => updateBudget(ctx, budgetId, parsed.data));
}

export async function setBudgetPinnedAction(
  budgetId: string,
  isPinned: boolean,
): Promise<BudgetWriteResult> {
  if (!idSchema.safeParse(budgetId).success || typeof isPinned !== 'boolean') return INVALID;
  const ctx = await getHouseholdContext();
  return run('固定预算', () => setBudgetPinned(ctx, budgetId, isPinned));
}

export async function deleteBudgetAction(budgetId: string): Promise<BudgetWriteResult> {
  if (!idSchema.safeParse(budgetId).success) return INVALID;
  const ctx = await getHouseholdContext();
  return run('删除预算', () => deleteBudget(ctx, budgetId));
}
