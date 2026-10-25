'use server';

// F8 行内修改的 Server Action（M4-8）。输入用 Zod 再校验一次，业务判断在 src/server/ 和 src/lib/rules/
// 日志里不打印数据库错误详情（参数里可能有交易描述）
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getHouseholdContext } from '@/server/context';
import {
  createRule,
  previewReapply,
  reapplyRules,
  type CreateRuleResult,
  type ReapplyPreview,
  type ReapplyResult,
} from '@/server/rules';
import { addSplit, removeSplit, updateSplit, type SplitWriteResult } from '@/server/splits';
import {
  bulkUpdate,
  confirmSuggestion,
  MAX_BULK_SIZE,
  rejectSuggestion,
  updateSplitCategory,
  updateSplitMember,
  type BulkUpdateResult,
  type SplitUpdateResult,
  type SuggestionResult,
} from '@/server/transactions';

type Failure = { ok: false; message: string };

const INVALID: Failure = { ok: false, message: '参数不合法' };

function failed(tag: string, err: unknown): Failure {
  // 事务已经回滚，什么都没改
  console.error(`[transactions] ${tag}失败`, err instanceof Error ? err.name : typeof err);
  return { ok: false, message: '保存失败，请稍后再试' };
}

// 'layout'：列表和详情页（/transactions/[id]）一起刷新
function refresh() {
  revalidatePath('/transactions', 'layout');
}

// ---------- 改分类、改归属人（R16.1、R16.2、R16.4） ----------

const splitCategorySchema = z.object({ splitId: z.uuid(), categoryId: z.uuid() });
const splitMemberSchema = z.object({ splitId: z.uuid(), memberId: z.uuid() });

export async function updateSplitCategoryAction(input: {
  splitId: string;
  categoryId: string;
}): Promise<SplitUpdateResult> {
  const parsed = splitCategorySchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await updateSplitCategory(ctx, parsed.data.splitId, parsed.data.categoryId);
    if (r.ok && r.changed) refresh();
    return r;
  } catch (err) {
    return failed('改分类', err);
  }
}

export async function updateSplitMemberAction(input: {
  splitId: string;
  memberId: string;
}): Promise<SplitUpdateResult> {
  const parsed = splitMemberSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await updateSplitMember(ctx, parsed.data.splitId, parsed.data.memberId);
    if (r.ok && r.changed) refresh();
    return r;
  } catch (err) {
    return failed('改归属人', err);
  }
}

// ---------- 批量修改（M4-9，R16.1、R16.2） ----------

// 一次只改一样：分类或归属人。跳过的规则和事务在 bulkUpdate 里
const bulkSchema = z.union([
  z.object({
    transactionIds: z.array(z.uuid()).min(1).max(MAX_BULK_SIZE),
    categoryId: z.uuid(),
  }),
  z.object({
    transactionIds: z.array(z.uuid()).min(1).max(MAX_BULK_SIZE),
    memberId: z.uuid(),
  }),
]);

export async function bulkUpdateAction(
  input: { transactionIds: string[] } & ({ categoryId: string } | { memberId: string }),
): Promise<BulkUpdateResult> {
  const parsed = bulkSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const { transactionIds, ...change } = parsed.data;
  const ctx = await getHouseholdContext();
  try {
    const r = await bulkUpdate(ctx, transactionIds, change);
    if (r.ok) refresh();
    return r;
  } catch (err) {
    return failed('批量修改', err);
  }
}

// ---------- 存成规则（R13、R16.6）和重新应用（R7.2） ----------

// 关键词的整理（去空格、转大写、长度）在 createRule 里做，这里只挡明显不对的
const createRuleSchema = z.object({
  keyword: z.string().max(200),
  categoryId: z.uuid(),
  overwrite: z.boolean().optional(),
});

// 匹配方式固定 contains，对话框里不让选（R16.9）
export async function createRuleAction(input: {
  keyword: string;
  categoryId: string;
  overwrite?: boolean;
}): Promise<CreateRuleResult> {
  const parsed = createRuleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid', message: '参数不合法' };
  const ctx = await getHouseholdContext();
  try {
    return await createRule(ctx, { ...parsed.data, matchType: 'contains' });
  } catch (err) {
    const f = failed('存规则', err);
    return { ok: false, reason: 'invalid', message: f.message };
  }
}

export async function previewReapplyAction(): Promise<({ ok: true } & ReapplyPreview) | Failure> {
  const ctx = await getHouseholdContext();
  try {
    return { ok: true, ...(await previewReapply(ctx)) };
  } catch (err) {
    console.error('[transactions] 预览重新应用失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '读取失败，请稍后再试' };
  }
}

export async function reapplyRulesAction(): Promise<({ ok: true } & ReapplyResult) | Failure> {
  const ctx = await getHouseholdContext();
  try {
    const r = await reapplyRules(ctx);
    refresh();
    return { ok: true, ...r };
  } catch (err) {
    return failed('重新应用规则', err);
  }
}

// ---------- 建议转账确认和拒绝（R6.3） ----------

export async function resolveSuggestionAction(input: {
  transactionId: string;
  action: 'confirm' | 'reject';
}): Promise<SuggestionResult> {
  const parsed = z
    .object({ transactionId: z.uuid(), action: z.enum(['confirm', 'reject']) })
    .safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const { transactionId, action } = parsed.data;
    const r =
      action === 'confirm'
        ? await confirmSuggestion(ctx, transactionId)
        : await rejectSuggestion(ctx, transactionId);
    if (r.ok) refresh();
    return r;
  } catch (err) {
    return failed(parsed.data.action === 'confirm' ? '确认转账' : '拒绝转账', err);
  }
}

// ---------- 拆分（M4-10，R15.2、R15.3） ----------
// 金额是用户填的正数（分），按交易符号转换和 < 主拆分的校验在 src/server/splits.ts

const noteInput = z.string().max(200).nullish();

const addSplitSchema = z.object({
  transactionId: z.uuid(),
  amountCents: z.number().int().positive(),
  categoryId: z.uuid(),
  memberId: z.uuid().nullish(), // 不选就按 R5 算
  note: noteInput,
});

export async function addSplitAction(
  input: z.input<typeof addSplitSchema>,
): Promise<SplitWriteResult> {
  const parsed = addSplitSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const { transactionId, ...rest } = parsed.data;
  const ctx = await getHouseholdContext();
  try {
    const r = await addSplit(ctx, transactionId, rest);
    if (r.ok) refresh();
    return r;
  } catch (err) {
    return failed('拆分', err);
  }
}

// 只传要改的字段；note 传 null 或空字符串是清空
const updateSplitSchema = z.object({
  splitId: z.uuid(),
  amountCents: z.number().int().positive().optional(),
  categoryId: z.uuid().optional(),
  memberId: z.uuid().optional(),
  note: noteInput,
});

export async function updateSplitAction(
  input: z.input<typeof updateSplitSchema>,
): Promise<SplitWriteResult> {
  const parsed = updateSplitSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const { splitId, ...rest } = parsed.data;
  // note 没传时不能带上 note 这个 key，否则会被当成清空
  const change = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const ctx = await getHouseholdContext();
  try {
    const r = await updateSplit(ctx, splitId, change);
    if (r.ok) refresh();
    return r;
  } catch (err) {
    return failed('改拆分', err);
  }
}

export async function removeSplitAction(input: { splitId: string }): Promise<SplitWriteResult> {
  const parsed = z.object({ splitId: z.uuid() }).safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await removeSplit(ctx, parsed.data.splitId);
    if (r.ok) refresh();
    return r;
  } catch (err) {
    return failed('删除拆分', err);
  }
}
