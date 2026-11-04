'use server';

// R25 目标的 Server Actions（M11-5）。校验（R25.1 的 11 条、账户属于本家庭）在 src/server/goals.ts 里做
// 首页固定的目标、预算"还能花"（R25.10）都读目标，一起刷新
import { revalidatePath } from 'next/cache';
import { getHouseholdContext } from '@/server/context';
import {
  completeGoal,
  createGoal,
  deleteGoal,
  moveGoal,
  reopenGoal,
  updateGoal,
  type GoalInput,
  type GoalWriteResult,
} from '@/server/goals';

function refresh(result: GoalWriteResult): GoalWriteResult {
  if (result.ok) {
    revalidatePath('/goals');
    revalidatePath('/');
  }
  return result;
}

export async function createGoalAction(
  input: GoalInput & { isEmergency: boolean },
): Promise<GoalWriteResult> {
  const ctx = await getHouseholdContext();
  return refresh(await createGoal(ctx, input));
}

// 卡片上的"固定到首页"开关也走这里：原样传现在的值，只改 isPinned
export async function updateGoalAction(goalId: string, input: GoalInput): Promise<GoalWriteResult> {
  const ctx = await getHouseholdContext();
  return refresh(await updateGoal(ctx, goalId, input));
}

export async function moveGoalAction(
  goalId: string,
  direction: 'up' | 'down',
): Promise<GoalWriteResult> {
  const ctx = await getHouseholdContext();
  return refresh(await moveGoal(ctx, goalId, direction));
}

// R25.9：yearly 返回的 goalId 是下一期
export async function completeGoalAction(goalId: string): Promise<GoalWriteResult> {
  const ctx = await getHouseholdContext();
  return refresh(await completeGoal(ctx, goalId));
}

export async function reopenGoalAction(goalId: string): Promise<GoalWriteResult> {
  const ctx = await getHouseholdContext();
  return refresh(await reopenGoal(ctx, goalId));
}

export async function deleteGoalAction(goalId: string): Promise<GoalWriteResult> {
  const ctx = await getHouseholdContext();
  return refresh(await deleteGoal(ctx, goalId));
}
