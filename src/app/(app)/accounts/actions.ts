'use server';

// R23.3 手动校准、R24.7 "其他"手动勾的 Server Actions。校验在 src/server/balances.ts、conditions.ts 里做
import { revalidatePath } from 'next/cache';
import { todayInMelbourne } from '@/lib/rules/periods';
import {
  addManualBalance,
  deleteManualBalance,
  type AddManualBalanceResult,
  type DeleteManualBalanceResult,
  type ManualBalanceInput,
} from '@/server/balances';
import { setManualCheck, type ConditionActionResult } from '@/server/conditions';
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

// R24.7 "其他"类型的手动勾：true 满足了 / false 没满足 / null 清掉
// 首页提示不管"其他"，但首页也读条件进度，一起刷新
export async function setManualCheckAction(
  conditionId: string,
  month: string,
  isMet: boolean | null,
): Promise<ConditionActionResult> {
  const ctx = await getHouseholdContext();
  const result = await setManualCheck(ctx, conditionId, month, isMet, todayInMelbourne());
  if (result.ok) {
    revalidatePath(PAGE);
    revalidatePath('/');
  }
  return result;
}
