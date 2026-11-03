'use server';

// R23.3 手动校准的 Server Actions。校验在 src/server/balances.ts 里用 Zod 做
import { revalidatePath } from 'next/cache';
import { todayInMelbourne } from '@/lib/rules/periods';
import {
  addManualBalance,
  deleteManualBalance,
  type AddManualBalanceResult,
  type DeleteManualBalanceResult,
  type ManualBalanceInput,
} from '@/server/balances';
import { getHouseholdContext } from '@/server/context';

const PAGE = '/accounts';

// 返回差额：null = 前面没锚点不比较，0 = 对上了
export async function addManualBalanceAction(
  input: ManualBalanceInput,
): Promise<AddManualBalanceResult> {
  const ctx = await getHouseholdContext();
  const result = await addManualBalance(ctx, input, todayInMelbourne());
  if (result.ok) revalidatePath(PAGE);
  return result;
}

// R23.3：填错了只能删了重填
export async function deleteManualBalanceAction(id: string): Promise<DeleteManualBalanceResult> {
  const ctx = await getHouseholdContext();
  const result = await deleteManualBalance(ctx, id);
  if (result.ok) revalidatePath(PAGE);
  return result;
}
