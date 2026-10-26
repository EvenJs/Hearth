// F3 手动录入的数据层（M6-2）：快速录入要的数据、新建、编辑、删除（R8.1、R17.1–R17.5）
// 字段怎么算由 src/lib/rules/manual.ts 的纯函数决定，这里负责读、校验形状、在一个事务里写回
// 每个查询都带 household_id
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import {
  card,
  category,
  categoryRule,
  financialAccount,
  member,
  transaction,
  transactionSplit,
} from '@/db/schema';
import {
  applyManualEdit,
  buildManualTransaction,
  canEditManual,
  frequentCategories,
  type EntryKind,
  type ManualAccount,
  type ManualContext,
  type ManualFieldErrors,
  type ManualSplit,
  type RecentManualUse,
} from '@/lib/rules/manual';
import { addDays } from '@/lib/rules/periods';
import { isSelectableCategory, typeOfCategory, type EditCategory } from '@/lib/rules/split-edit';
import type { Card, CategoryRule, CategorySource, Member, MemberSource } from '@/lib/rules/types';
import type { HouseholdContext } from './context';
import { primarySplitJoin } from './transfers';
import type { DbTx } from './transactions';

// ---------- 返回的形状 ----------

export type ManualFailure = { ok: false; errors: ManualFieldErrors & { form?: string } };
export type CreateManualResult = { ok: true; id: string } | ManualFailure;
export type UpdateManualResult = { ok: true; changed: boolean } | ManualFailure;
export type DeleteManualResult = { ok: true } | ManualFailure;

// 前端显示要中文名和排序，规则函数只看 EditCategory 的字段
export type QuickAddCategory = EditCategory & { nameZh: string | null };

export type QuickAddContext = {
  accounts: ManualAccount[]; // 没归档的，带 bank 显示状态提示（R8.1）
  lastAccountId: string | null; // R17.2 上次账户，归档了或没录过 → null
  categories: QuickAddCategory[]; // 全部（含归档的，标 isArchived），guessCategory 要能找到规则指向的分类
  rules: CategoryRule[];
  cards: Card[];
  members: Member[]; // 没归档的
  frequent: Record<EntryKind, string[]>; // R17.2 常用分类，每边最多 4 个
};

const FREQUENT_COUNT = 4;
const FREQUENT_WINDOW_DAYS = 90;

const NOT_FOUND: ManualFailure = { ok: false, errors: { form: '找不到这笔交易' } };

// ---------- 读家庭配置 ----------

// 分类：一级归档时二级也当成归档（R16.3），和 loadEditContext 一样
async function loadCategories(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
): Promise<QuickAddCategory[]> {
  const rows = await tx
    .select({
      id: category.id,
      parentId: category.parentId,
      nameEn: category.nameEn,
      nameZh: category.nameZh,
      kind: category.kind,
      systemKey: category.systemKey,
      defaultMemberId: category.defaultMemberId,
      isPreTaxDefault: category.isPreTaxDefault,
      isOther: category.isOther,
      isArchived: category.isArchived,
    })
    .from(category)
    .where(eq(category.householdId, ctx.householdId))
    .orderBy(asc(category.sortOrder), asc(category.nameEn));
  const archived = new Set(rows.filter((c) => c.isArchived).map((c) => c.id));
  return rows.map((c) => ({
    ...c,
    isArchived: c.isArchived || (c.parentId !== null && archived.has(c.parentId)),
  }));
}

async function loadManualContext(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
  today: string,
): Promise<ManualContext & { categories: QuickAddCategory[] }> {
  const hh = ctx.householdId;
  const [categories, accounts, cards, members, rules] = await Promise.all([
    loadCategories(tx, ctx),
    tx
      .select({
        id: financialAccount.id,
        name: financialAccount.name,
        bank: financialAccount.bank,
        type: financialAccount.type,
        defaultMemberId: financialAccount.defaultMemberId,
        numberSuffix: financialAccount.numberSuffix,
        isArchived: financialAccount.isArchived,
      })
      .from(financialAccount)
      .where(eq(financialAccount.householdId, hh))
      .orderBy(asc(financialAccount.isArchived), asc(financialAccount.name)),
    tx
      .select({
        id: card.id,
        accountId: card.accountId,
        last4: card.last4,
        memberId: card.memberId,
      })
      .from(card)
      .where(eq(card.householdId, hh)),
    // 归档的归属人不能选（和 isActiveMember 一样）
    tx
      .select({ id: member.id, name: member.name, kind: member.kind })
      .from(member)
      .where(and(eq(member.householdId, hh), eq(member.isArchived, false)))
      .orderBy(asc(member.sortOrder), asc(member.name)),
    tx
      .select({
        id: categoryRule.id,
        keyword: categoryRule.keyword,
        matchType: categoryRule.matchType,
        categoryId: categoryRule.categoryId,
        priority: categoryRule.priority,
        isSystem: categoryRule.isSystem,
        createdAt: categoryRule.createdAt,
      })
      .from(categoryRule)
      .where(eq(categoryRule.householdId, hh)),
  ]);
  return { categories, accounts, cards, members, rules, today };
}

// ---------- 快速录入的上下文 ----------

// R17.2 上次账户：当前用户最近一笔 source = manual 的交易（按 created_at）的账户
async function lastManualAccountId(
  ctx: HouseholdContext,
  accounts: readonly ManualAccount[],
): Promise<string | null> {
  const [row] = await db
    .select({ accountId: transaction.accountId })
    .from(transaction)
    .where(
      and(
        eq(transaction.householdId, ctx.householdId),
        eq(transaction.source, 'manual'),
        eq(transaction.createdBy, ctx.userId),
      ),
    )
    .orderBy(desc(transaction.createdAt), desc(transaction.id))
    .limit(1);
  if (!row) return null;
  const account = accounts.find((a) => a.id === row.accountId);
  return account && !account.isArchived ? account.id : null;
}

// R17.2 常用分类：本家庭 source = manual 的交易，最近 90 天的主拆分
async function recentManualUses(
  ctx: HouseholdContext,
  categories: readonly QuickAddCategory[],
  today: string,
): Promise<RecentManualUse[]> {
  const rows = await db
    .select({
      categoryId: transactionSplit.categoryId,
      date: transaction.date,
      createdAt: transaction.createdAt,
    })
    .from(transaction)
    .innerJoin(transactionSplit, primarySplitJoin)
    .where(
      and(
        eq(transaction.householdId, ctx.householdId),
        eq(transaction.source, 'manual'),
        gte(transaction.date, addDays(today, -FREQUENT_WINDOW_DAYS)),
        lte(transaction.date, today),
      ),
    );

  // 现在不能选的分类（归档了、内部转账）不放进常用里
  const byId = new Map(categories.map((c) => [c.id, c]));
  return rows.flatMap((r) => {
    const c = byId.get(r.categoryId);
    if (!c || !isSelectableCategory(c)) return [];
    return [{ ...r, categoryType: typeOfCategory(c) }];
  });
}

// F3 弹窗打开时要的全部数据。today 用 todayInMelbourne()
export async function getQuickAddContext(
  ctx: HouseholdContext,
  today: string,
): Promise<QuickAddContext> {
  const m = await loadManualContext(db, ctx, today);
  const accounts = m.accounts.filter((a) => !a.isArchived);
  const [lastAccountId, recent] = await Promise.all([
    lastManualAccountId(ctx, m.accounts),
    recentManualUses(ctx, m.categories, today),
  ]);
  return {
    accounts: [...accounts],
    lastAccountId,
    categories: m.categories,
    rules: [...m.rules],
    cards: [...m.cards],
    members: [...m.members],
    frequent: {
      expense: frequentCategories(recent, 'expense', today, FREQUENT_COUNT),
      income: frequentCategories(recent, 'income', today, FREQUENT_COUNT),
    },
  };
}

// ---------- 校验形状 ----------

// 只查形状和长度上限，业务规则（金额、日期、分类类型……）交给纯函数，错误信息也由它给
const inputSchema = z.object({
  amount: z.string().max(20),
  kind: z.enum(['expense', 'income']),
  description: z.string().max(500),
  accountId: z.uuid(),
  date: z.string().max(10),
  categoryId: z.uuid().nullable(),
  categoryGuessed: z.boolean(),
  memberId: z.uuid().nullable(),
});

const editSchema = z
  .object({
    amount: z.string().max(20).optional(),
    kind: z.enum(['expense', 'income']).optional(),
    description: z.string().max(500).optional(),
    accountId: z.uuid().optional(),
    date: z.string().max(10).optional(),
  })
  .strict();

export type CreateManualInput = z.input<typeof inputSchema>;
export type UpdateManualInput = z.input<typeof editSchema>;

// Zod 错误 → 字段错误，字段名就是 path 第一段
function shapeErrors(error: z.ZodError): ManualFailure {
  const errors: ManualFailure['errors'] = {};
  for (const issue of error.issues) {
    const key = (issue.path[0] ?? 'form') as keyof ManualFailure['errors'];
    errors[key] ??= '参数不合法';
  }
  return { ok: false, errors };
}

// ---------- 新建 ----------

// R17.1：一个事务写交易和主拆分。别家的账户、分类、归属人不在本家庭的配置里，按字段报错
export async function createManualTransaction(
  ctx: HouseholdContext,
  input: CreateManualInput,
  today: string,
): Promise<CreateManualResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return shapeErrors(parsed.error);

  return db.transaction(async (tx) => {
    const m = await loadManualContext(tx, ctx, today);
    const r = buildManualTransaction(parsed.data, m);
    if (!r.ok) return r;

    const [row] = await tx
      .insert(transaction)
      .values({ ...r.transaction, householdId: ctx.householdId, createdBy: ctx.userId })
      .returning({ id: transaction.id });
    await tx
      .insert(transactionSplit)
      .values({ ...r.split, householdId: ctx.householdId, transactionId: row.id });
    return { ok: true, id: row.id };
  });
}

// ---------- 编辑、删除 ----------

// 锁住交易和它的拆分，读出 R17.5 要的字段。不是本家庭的 → null
async function lockManual(tx: DbTx, ctx: HouseholdContext, id: string) {
  const [row] = await tx
    .select({
      source: transaction.source,
      importBatchId: transaction.importBatchId,
      transferPairId: transaction.transferPairId,
      accountId: transaction.accountId,
      date: transaction.date,
      amountCents: transaction.amountCents,
      rawDescription: transaction.rawDescription,
      merchant: transaction.merchant,
      status: transaction.status,
    })
    .from(transaction)
    .where(and(eq(transaction.id, id), eq(transaction.householdId, ctx.householdId)))
    .for('update');
  if (!row) return null;

  const splits = await tx
    .select({
      id: transactionSplit.id,
      isPrimary: transactionSplit.isPrimary,
      amountCents: transactionSplit.amountCents,
      categoryId: transactionSplit.categoryId,
      categorySource: transactionSplit.categorySource,
      memberId: transactionSplit.memberId,
      memberSource: transactionSplit.memberSource,
    })
    .from(transactionSplit)
    .where(
      and(
        eq(transactionSplit.transactionId, id),
        eq(transactionSplit.householdId, ctx.householdId),
      ),
    )
    .orderBy(asc(transactionSplit.id))
    .for('update');

  return {
    tx: row,
    splits: splits.map((s): ManualSplit => ({
      ...s,
      categorySource: s.categorySource as CategorySource,
      memberSource: s.memberSource as MemberSource,
    })),
  };
}

// R17.5 编辑日期、金额、描述、账户。被导入确认过的、导入的交易报错，什么都不改
export async function updateManualTransaction(
  ctx: HouseholdContext,
  id: string,
  edit: UpdateManualInput,
  today: string,
): Promise<UpdateManualResult> {
  if (!z.uuid().safeParse(id).success) return NOT_FOUND;
  const parsed = editSchema.safeParse(edit);
  if (!parsed.success) return shapeErrors(parsed.error);

  return db.transaction(async (tx) => {
    const locked = await lockManual(tx, ctx, id);
    if (!locked) return NOT_FOUND;

    const m = await loadManualContext(tx, ctx, today);
    const r = applyManualEdit(locked.tx, locked.splits, parsed.data, m);
    if (!r.ok) return r;

    // R15.1：改完以后拆分合计还要等于交易金额。不满足说明纯函数有 bug，抛错回滚
    const amountCents = r.transaction.amountCents ?? locked.tx.amountCents;
    const sum = locked.splits.reduce(
      (s, x) => s + (r.splits.find((c) => c.id === x.id)?.amountCents ?? x.amountCents),
      0,
    );
    if (sum !== amountCents) {
      throw new Error(`R15.1 不满足：合计 ${sum}，交易 ${amountCents}`);
    }

    const changed = Object.keys(r.transaction).length > 0 || r.splits.length > 0;
    if (Object.keys(r.transaction).length > 0) {
      await tx
        .update(transaction)
        .set(r.transaction)
        .where(and(eq(transaction.id, id), eq(transaction.householdId, ctx.householdId)));
    }
    for (const { id: splitId, ...patch } of r.splits) {
      await tx
        .update(transactionSplit)
        .set(patch)
        .where(
          and(eq(transactionSplit.id, splitId), eq(transactionSplit.householdId, ctx.householdId)),
        );
    }
    return { ok: true, changed };
  });
}

// R17.5 删除：硬删除，拆分级联删除。有 transfer_pair_id 的、被导入确认过的不能删
export async function deleteManualTransaction(
  ctx: HouseholdContext,
  id: string,
): Promise<DeleteManualResult> {
  if (!z.uuid().safeParse(id).success) return NOT_FOUND;

  return db.transaction(async (tx) => {
    const locked = await lockManual(tx, ctx, id);
    if (!locked) return NOT_FOUND;

    const permission = canEditManual(locked.tx);
    if (!permission.canDelete) return { ok: false, errors: { form: permission.reason! } };

    await tx
      .delete(transaction)
      .where(and(eq(transaction.id, id), eq(transaction.householdId, ctx.householdId)));
    return { ok: true };
  });
}
