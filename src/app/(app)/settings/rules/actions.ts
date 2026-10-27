'use server';

// 设置 → 规则的 Server Actions（M6.5-4，R18）。输入在这里用 Zod 再校验一次（前端校验可以被绕过）
// 关键词的规范化、分类能不能选、撞没撞在 src/server/rules.ts（checkRuleEdit）里做
// "要对 N 笔应用吗"用 F8 的 previewReapplyAction / reapplyRulesAction，不另写
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { RULE_MATCH_TYPES } from '@/lib/rules/types';
import { getHouseholdContext } from '@/server/context';
import {
  createRuleFromSettings,
  deleteRule,
  updateRule,
  type RuleWriteInput,
  type RuleWriteResult,
} from '@/server/rules';

const PAGE = '/settings/rules';

const inputSchema = z.object({
  keyword: z.string().max(1000),
  matchType: z.enum(RULE_MATCH_TYPES),
  categoryId: z.uuid(),
});
const idSchema = z.uuid();

const INVALID: RuleWriteResult = { ok: false, reason: 'invalid', message: '请检查输入' };
const FAILED: RuleWriteResult = { ok: false, reason: 'invalid', message: '保存失败，请稍后再试' };

async function run(what: string, write: () => Promise<RuleWriteResult>): Promise<RuleWriteResult> {
  try {
    const r = await write();
    if (r.ok) revalidatePath(PAGE);
    return r;
  } catch (err) {
    // 不打印错误内容，免得把关键词之类的数据写进日志
    console.error(`[rules] ${what}失败`, err instanceof Error ? err.name : typeof err);
    return FAILED;
  }
}

export async function createRuleAction(input: RuleWriteInput): Promise<RuleWriteResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  return run('新建规则', () => createRuleFromSettings(ctx, parsed.data));
}

export async function updateRuleAction(
  ruleId: string,
  input: RuleWriteInput,
): Promise<RuleWriteResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || !idSchema.safeParse(ruleId).success) return INVALID;
  const ctx = await getHouseholdContext();
  return run('修改规则', () => updateRule(ctx, ruleId, parsed.data));
}

export async function deleteRuleAction(ruleId: string): Promise<RuleWriteResult> {
  if (!idSchema.safeParse(ruleId).success) return INVALID;
  const ctx = await getHouseholdContext();
  return run('删除规则', () => deleteRule(ctx, ruleId));
}
