// F8 改完分类、归属人之后的追问（business-rules.md R16.9、R16.10，M5.5-4）
// "同商家" = merchant 包含 R13 建议的关键词。先在 SQL 里用 ILIKE 筛，再交给 src/lib/rules/follow-up.ts 的纯函数判断
// 每个查询都带 household_id
import { and, asc, eq, ilike, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { member, transaction, transactionSplit } from '@/db/schema';
import {
  planMemberPropagation,
  shouldOfferRule,
  type MemberPropagation,
  type PropagationTx,
  type RuleOffer,
  type RuleOfferInput,
} from '@/lib/rules/follow-up';
import { suggestKeyword } from '@/lib/rules/keyword';
import type { CategorySource, MemberSource } from '@/lib/rules/types';
import type { HouseholdContext } from './context';
import { isActiveMember } from './members';
import { writeSplit, type DbTx } from './transactions';

type Executor = DbTx | typeof db;

// ILIKE 里 % _ \ 是通配符，关键词按字面匹配
function containsPattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

async function merchantOf(
  exec: Executor,
  ctx: HouseholdContext,
  transactionId: string,
): Promise<string | null> {
  const [row] = await exec
    .select({ merchant: transaction.merchant })
    .from(transaction)
    .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, ctx.householdId)));
  return row?.merchant ?? null;
}

// ---------- R16.9 ----------

// R16.9 改完分类后：弹"存成规则"对话框、只在 toast 给入口、还是什么都不做
// 交易找不到（比如刚被撤销导入）→ none
export async function getRuleOffer(
  ctx: HouseholdContext,
  transactionId: string,
  change: Omit<RuleOfferInput, 'transactionId' | 'merchant'>,
): Promise<RuleOffer> {
  if (!z.uuid().safeParse(transactionId).success) return 'none';
  // 前三条不满足时不用查数据库
  if (shouldOfferRule({ ...change, transactionId, merchant: '' }, []) === 'none') return 'none';

  const merchant = await merchantOf(db, ctx, transactionId);
  if (merchant === null) return 'none';
  // 有一笔类似的就够了
  const similar = await db
    .select({ id: transaction.id, merchant: transaction.merchant })
    .from(transaction)
    .where(
      and(
        eq(transaction.householdId, ctx.householdId),
        ne(transaction.id, transactionId),
        ilike(transaction.merchant, containsPattern(suggestKeyword(merchant))),
      ),
    )
    .limit(1);
  return shouldOfferRule({ ...change, transactionId, merchant }, similar);
}

// ---------- R16.10 ----------

// R16.10 的候选：本家庭除了这笔以外，merchant 含关键词的交易，带全部拆分
async function loadPropagationCandidates(
  exec: Executor,
  ctx: HouseholdContext,
  transactionId: string,
  keyword: string,
  lock: boolean,
): Promise<PropagationTx[]> {
  const hh = ctx.householdId;
  const txRows = await exec
    .select({
      id: transaction.id,
      merchant: transaction.merchant,
      transferStatus: transaction.transferStatus,
    })
    .from(transaction)
    .where(
      and(
        eq(transaction.householdId, hh),
        ne(transaction.id, transactionId),
        ilike(transaction.merchant, containsPattern(keyword)),
      ),
    )
    .orderBy(asc(transaction.date), asc(transaction.id));
  if (txRows.length === 0) return [];

  const splitQuery = exec
    .select({
      id: transactionSplit.id,
      transactionId: transactionSplit.transactionId,
      categoryId: transactionSplit.categoryId,
      categorySource: transactionSplit.categorySource,
      memberId: transactionSplit.memberId,
      memberSource: transactionSplit.memberSource,
      isPreTax: transactionSplit.isPreTax,
    })
    .from(transactionSplit)
    .where(
      and(
        eq(transactionSplit.householdId, hh),
        inArray(
          transactionSplit.transactionId,
          txRows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(transactionSplit.id));
  const splitRows = lock ? await splitQuery.for('update') : await splitQuery;

  const byTx = new Map<string, PropagationTx['splits'][number][]>();
  for (const s of splitRows) {
    const list = byTx.get(s.transactionId) ?? [];
    list.push({
      id: s.id,
      categoryId: s.categoryId,
      categorySource: s.categorySource as CategorySource,
      memberId: s.memberId,
      memberSource: s.memberSource as MemberSource,
      isPreTax: s.isPreTax,
    });
    byTx.set(s.transactionId, list);
  }
  return txRows.map((r) => ({ ...r, splits: byTx.get(r.id) ?? [] }));
}

async function planPropagation(
  exec: Executor,
  ctx: HouseholdContext,
  transactionId: string,
  memberId: string,
  lock: boolean,
): Promise<MemberPropagation | null> {
  const merchant = await merchantOf(exec, ctx, transactionId);
  if (merchant === null) return null;
  const keyword = suggestKeyword(merchant);
  const others = await loadPropagationCandidates(exec, ctx, transactionId, keyword, lock);
  return planMemberPropagation({ id: transactionId, merchant }, memberId, others);
}

// 弹窗文案："商家含 {keyword} 的还有 {count} 笔归属人不是 {memberName}，要一起改吗？"
export type PropagationPreview = { keyword: string; count: number; memberName: string };

// R16.10 行内改了主拆分的归属人之后，看有没有同商家的交易要一起改。只读；0 笔 → count = 0，不弹
// splitId 是刚改的那个拆分，不是主拆分（多拆分交易的子行）时 → null
export async function previewMemberPropagation(
  ctx: HouseholdContext,
  splitId: string,
): Promise<PropagationPreview | null> {
  if (!z.uuid().safeParse(splitId).success) return null;
  const [split] = await db
    .select({
      transactionId: transactionSplit.transactionId,
      memberId: transactionSplit.memberId,
      isPrimary: transactionSplit.isPrimary,
      memberName: member.name,
    })
    .from(transactionSplit)
    .innerJoin(member, eq(member.id, transactionSplit.memberId))
    .where(
      and(eq(transactionSplit.id, splitId), eq(transactionSplit.householdId, ctx.householdId)),
    );
  if (!split || !split.isPrimary) return null;

  const plan = await planPropagation(db, ctx, split.transactionId, split.memberId, false);
  if (!plan) return null;
  return { keyword: plan.keyword, count: plan.updates.length, memberName: split.memberName };
}

export type PropagationResult = { ok: true; updatedCount: number } | { ok: false; message: string };

// R16.10 确认后：同商家的交易归属人都改成 memberId，member_source = manual，一个事务
// 在事务里重新算一遍并锁住拆分（中间可能又改过），所以实际笔数可能和预览不一样
export async function applyMemberPropagation(
  ctx: HouseholdContext,
  transactionId: string,
  memberId: string,
): Promise<PropagationResult> {
  if (!z.uuid().safeParse(transactionId).success || !z.uuid().safeParse(memberId).success) {
    return { ok: false, message: '参数不合法' };
  }
  if (!(await isActiveMember(ctx, memberId))) return { ok: false, message: '不能选这个归属人' };

  return db.transaction(async (tx) => {
    const plan = await planPropagation(tx, ctx, transactionId, memberId, true);
    if (!plan) return { ok: false, message: '找不到这笔交易' };
    for (const u of plan.updates) await writeSplit(tx, ctx, u.split);
    return { ok: true, updatedCount: plan.updates.length };
  });
}
