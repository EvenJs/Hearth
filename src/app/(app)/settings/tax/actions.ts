'use server';

// 设置 → 税务的 Server Actions（M7-5，R14.7）。输入在这里用 Zod 再校验一次（前端校验可以被绕过）
// 金额转分、已代扣 ≤ 税前总额、财年有没有税率表、member 是不是 person 在 src/server/tax.ts 里判断
// 清除工资信息见 R14.8；在职段（M14-4，R14.9）的年薪、日期检查也在 src/server/tax.ts 里
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getHouseholdContext } from '@/server/context';
import {
  createTaxJob,
  deleteTaxJob,
  deleteTaxProfile,
  saveTaxProfile,
  updateTaxJob,
  type TaxWriteResult,
} from '@/server/tax';

const saveSchema = z.object({
  memberId: z.uuid(),
  financialYear: z.number().int(),
  paygGross: z.string().max(100),
  paygWithheld: z.string().max(100),
  // 空串 = 没填（R14.10）
  expectedInterest: z.string().max(100),
});

export type SaveTaxProfileActionInput = z.infer<typeof saveSchema>;

const INVALID = { ok: false, reason: 'invalid', message: '请检查输入' } as const;
const FAILED = { ok: false, reason: 'invalid', message: '保存失败，请稍后再试' } as const;

export async function saveTaxProfileAction(
  input: SaveTaxProfileActionInput,
): Promise<TaxWriteResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await saveTaxProfile(ctx, parsed.data);
    // 设置页的估算表和看板的税务卡片（M7-6）
    if (r.ok) revalidatePath('/', 'layout');
    return r;
  } catch (err) {
    // 不打印错误内容，免得把金额之类的数据写进日志
    console.error('[tax] 保存工资信息失败', err instanceof Error ? err.name : typeof err);
    return FAILED;
  }
}

const deleteSchema = z.object({
  memberId: z.uuid(),
  financialYear: z.number().int(),
});

export type DeleteTaxProfileActionInput = z.infer<typeof deleteSchema>;

const DELETE_FAILED = { ok: false, reason: 'invalid', message: '清除失败，请稍后再试' } as const;

export async function deleteTaxProfileAction(
  input: DeleteTaxProfileActionInput,
): Promise<TaxWriteResult> {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await deleteTaxProfile(ctx, parsed.data);
    if (r.ok) revalidatePath('/', 'layout');
    return r;
  } catch (err) {
    console.error('[tax] 清除工资信息失败', err instanceof Error ? err.name : typeof err);
    return DELETE_FAILED;
  }
}

// ---------- 在职段（R14.9） ----------

const jobFieldsSchema = z.object({
  employer: z.string().max(100),
  annualSalary: z.string().max(100),
  startDate: z.iso.date(),
  endDate: z.union([z.iso.date(), z.literal('')]), // 空串 = 还在职
});

const createJobSchema = jobFieldsSchema.extend({ memberId: z.uuid() });
const updateJobSchema = jobFieldsSchema.extend({ id: z.uuid() });
const deleteJobSchema = z.object({ id: z.uuid() });

export type CreateTaxJobActionInput = z.infer<typeof createJobSchema>;
export type UpdateTaxJobActionInput = z.infer<typeof updateJobSchema>;
export type DeleteTaxJobActionInput = z.infer<typeof deleteJobSchema>;

const JOB_DELETE_FAILED = { ok: false, reason: 'invalid', message: '删除失败，请稍后再试' } as const;

export async function createTaxJobAction(input: CreateTaxJobActionInput): Promise<TaxWriteResult> {
  const parsed = createJobSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await createTaxJob(ctx, parsed.data);
    if (r.ok) revalidatePath('/', 'layout');
    return r;
  } catch (err) {
    console.error('[tax] 新增在职段失败', err instanceof Error ? err.name : typeof err);
    return FAILED;
  }
}

export async function updateTaxJobAction(input: UpdateTaxJobActionInput): Promise<TaxWriteResult> {
  const parsed = updateJobSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await updateTaxJob(ctx, parsed.data);
    if (r.ok) revalidatePath('/', 'layout');
    return r;
  } catch (err) {
    console.error('[tax] 修改在职段失败', err instanceof Error ? err.name : typeof err);
    return FAILED;
  }
}

export async function deleteTaxJobAction(input: DeleteTaxJobActionInput): Promise<TaxWriteResult> {
  const parsed = deleteJobSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await deleteTaxJob(ctx, parsed.data);
    if (r.ok) revalidatePath('/', 'layout');
    return r;
  } catch (err) {
    console.error('[tax] 删除在职段失败', err instanceof Error ? err.name : typeof err);
    return JOB_DELETE_FAILED;
  }
}
