'use server';

// F3 快速录入的 Server Actions（M6-3）
// 输入的形状由 createManualTransaction 里的 Zod 校验，业务规则在 src/lib/rules/manual.ts
// 日志里不打印数据库错误详情（参数里有交易描述）
import { revalidatePath } from 'next/cache';
import { todayInMelbourne } from '@/lib/rules/periods';
import { getHouseholdContext } from '@/server/context';
import {
  createManualTransaction,
  getQuickAddContext,
  type CreateManualInput,
  type CreateManualResult,
  type QuickAddContext,
} from '@/server/manual';

export type QuickAddData = QuickAddContext & { today: string };

// 每次打开弹窗取一次：今天、上次账户、常用分类都是最新的
export async function getQuickAddDataAction(): Promise<
  { ok: true; data: QuickAddData } | { ok: false; message: string }
> {
  // 没登录时 getHouseholdContext 会 redirect，不能放进 try（会被吞掉）
  const ctx = await getHouseholdContext();
  try {
    const today = todayInMelbourne();
    const data = await getQuickAddContext(ctx, today);
    return { ok: true, data: { ...data, today } };
  } catch (err) {
    console.error('[quick-add] 读取失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '加载失败，请关掉再试' };
  }
}

// R17.1 新建一笔。成功后看板和 F8（含详情页）一起刷新
export async function createQuickAddAction(input: CreateManualInput): Promise<CreateManualResult> {
  const ctx = await getHouseholdContext();
  try {
    const r = await createManualTransaction(ctx, input, todayInMelbourne());
    if (r.ok) revalidatePath('/', 'layout');
    return r;
  } catch (err) {
    // 事务已经回滚，什么都没写
    console.error('[quick-add] 保存失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, errors: { form: '保存失败，请稍后再试' } };
  }
}
