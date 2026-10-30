'use server';

// 设置 → 税务的 Server Actions（M7-5，R14.7）。输入在这里用 Zod 再校验一次（前端校验可以被绕过）
// 金额转分、已代扣 ≤ 税前总额、财年有没有税率表、member 是不是 person 在 src/server/tax.ts 里判断
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getHouseholdContext } from '@/server/context';
import { saveTaxProfile, type TaxWriteResult } from '@/server/tax';

const saveSchema = z.object({
  memberId: z.uuid(),
  financialYear: z.number().int(),
  paygGross: z.string().max(100),
  paygWithheld: z.string().max(100),
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
