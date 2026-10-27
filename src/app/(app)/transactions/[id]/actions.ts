'use server';

// 交易详情里编辑、删除手动录入的整笔交易（R17.5，M6-5）
// 能不能改、字段规则都在 src/server/manual.ts 和 src/lib/rules/manual.ts，这里只调用、刷新页面
// 日志里不打印数据库错误详情（参数里有交易描述）
import { revalidatePath } from 'next/cache';
import { todayInMelbourne } from '@/lib/rules/periods';
import { getHouseholdContext } from '@/server/context';
import {
  deleteManualTransaction,
  updateManualTransaction,
  type DeleteManualResult,
  type UpdateManualInput,
  type UpdateManualResult,
} from '@/server/manual';

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
