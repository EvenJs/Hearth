'use server';

// 交易详情里编辑、删除手动录入的整笔交易（R17.5，M6-5）；勾一次性（R22.1、R22.3，M7.7-5）；挂到目标（R25.7，M11-6）
// 能不能改、字段规则都在 src/server/manual.ts、splits.ts 和 src/lib/rules/，这里只调用、刷新页面
// 日志里不打印数据库错误详情（参数里有交易描述）
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { todayInMelbourne } from '@/lib/rules/periods';
import { getHouseholdContext } from '@/server/context';
import { linkSplitToGoal, type LinkSplitResult } from '@/server/goals';
import {
  deleteManualTransaction,
  updateManualTransaction,
  type DeleteManualResult,
  type UpdateManualInput,
  type UpdateManualResult,
} from '@/server/manual';
import { dismissOneOffHint, setSplitOneOff, type SplitWriteResult } from '@/server/splits';

const INVALID = { ok: false, message: '参数不合法' } as const;

// 看板、F8 列表和详情页都会变
function refresh() {
  revalidatePath('/', 'layout');
}

export async function updateManualAction(
  id: string,
  edit: UpdateManualInput,
): Promise<UpdateManualResult> {
  // 没登录时 getHouseholdContext 会 redirect，不能放进 try（会被吞掉）
  const ctx = await getHouseholdContext();
  try {
    const r = await updateManualTransaction(ctx, id, edit, todayInMelbourne());
    if (r.ok && r.changed) refresh();
    return r;
  } catch (err) {
    // 事务已经回滚，什么都没改
    console.error('[manual] 编辑失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, errors: { form: '保存失败，请稍后再试' } };
  }
}

export async function deleteManualAction(id: string): Promise<DeleteManualResult> {
  const ctx = await getHouseholdContext();
  try {
    const r = await deleteManualTransaction(ctx, id);
    if (r.ok) refresh();
    return r;
  } catch (err) {
    console.error('[manual] 删除失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, errors: { form: '删除失败，请稍后再试' } };
  }
}

// R22.1 拆分上的勾选：勾上 true，取消 false
const oneOffSchema = z.object({ splitId: z.uuid(), value: z.boolean() });

export async function setSplitOneOffAction(
  input: z.input<typeof oneOffSchema>,
): Promise<SplitWriteResult> {
  const parsed = oneOffSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await setSplitOneOff(ctx, parsed.data.splitId, parsed.data.value);
    if (r.ok) refresh();
    return r;
  } catch (err) {
    console.error('[one-off] 标记失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '保存失败，请稍后再试' };
  }
}

// R22.3 大额提示的"是"（true）/"不是一次性"（false）：这笔所有 null 的支出拆分设成 value
const hintSchema = z.object({ transactionId: z.uuid(), value: z.boolean() });

export async function answerOneOffHintAction(
  input: z.input<typeof hintSchema>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = hintSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await dismissOneOffHint(ctx, parsed.data.transactionId, parsed.data.value);
    if (r.ok) refresh();
    return r;
  } catch (err) {
    console.error('[one-off] 标记失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '保存失败，请稍后再试' };
  }
}

// R25.7 拆分挂到目标：goalId = null 是"不挂"。挂上时 linkSplitToGoal 同一个事务里勾一次性
const goalSchema = z.object({ splitId: z.uuid(), goalId: z.uuid().nullable() });

export async function linkSplitGoalAction(
  input: z.input<typeof goalSchema>,
): Promise<LinkSplitResult> {
  const parsed = goalSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await linkSplitToGoal(ctx, parsed.data.splitId, parsed.data.goalId);
    if (r.ok) refresh(); // /goals 的实际、月均也在 layout 下
    return r;
  } catch (err) {
    console.error('[goal] 挂目标失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '保存失败，请稍后再试' };
  }
}
