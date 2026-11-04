// R24 每月条件的数据访问（M10-4）：配置、"其他"的手动勾、本月和最近 12 个月的结果
// 判断都用 src/lib/rules/conditions.ts 的纯函数，结果每次实时算，不存
// 交易一次查完最近 12 个月（balance_growth 的账户往前查到上月末之前最近的锚点），按账户分好再喂纯函数
// 每个查询都带 household_id
import { and, eq, gt, inArray, isNull, max, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '@/db';
import {
  accountCondition,
  accountConditionCheck,
  category,
  financialAccount,
  transaction,
  transactionSplit,
} from '@/db/schema';
import { pickAnchor } from '@/lib/rules/balance';
import {
  CONDITION_OUTCOMES,
  CONDITION_TYPES,
  DEPOSIT_FILTERS,
  dataAsOf,
  evaluateCondition,
  feeMismatch,
  homeReminder,
  isJudgedIn,
  monthsForHistory,
  resolveCounterparty,
  summarizeAccountMonth,
  type AccountMonthSummary,
  type ConditionAccount,
  type ConditionOutcome,
  type ConditionResult,
  type ConditionTx,
  type ConditionType,
  type DepositFilter,
  type HomeReminder,
  type ManualCheck,
  type MonthlyCondition,
  type ReminderItem,
} from '@/lib/rules/conditions';
import { addDays, endOfMonth, lastTwelveMonths, startOfMonth } from '@/lib/rules/periods';
import type { Account as RuleAccount } from '@/lib/rules/types';
import { findInterestCategoryId, loadAnchors, type StoredAnchor } from './balances';
import type { HouseholdContext } from './context';
import type { DbTx } from './transactions';

// ---------- 返回的形状 ----------

export type StoredCondition = MonthlyCondition & {
  effectiveFrom: string;
  disabledFrom: string | null;
  createdAt: Date;
};

export type ConditionMonth = {
  month: string; // 月初
  results: ConditionResult[]; // 这个月在判断的条件（isJudgedIn），空 = "没有条件"
  summary: AccountMonthSummary;
  feeMismatchCents: number | null; // R24.8，null = 不提示
  interestCents: number; // R24.10 这个月的 Income / Interest，pending 也算
};

export type AccountConditionProgress = {
  accountId: string;
  accountName: string;
  conditions: StoredCondition[]; // 这个账户所有条件，含停用的（历史点开要用）
  thisMonth: ConditionMonth | null; // 本月一个在判断的条件都没有 → null，不显示"本月条件"
  history: ConditionMonth[]; // R24.10 最近 12 个月（含本月），从最早的 effective_from 开始，旧的在前
};

export type ConditionProgress = {
  accounts: AccountConditionProgress[]; // 没归档、有条件的账户，按账户建的先后
  reminder: HomeReminder | null; // R24.9
};

export type ConditionErrors = Partial<
  Record<
    | 'accountId'
    | 'type'
    | 'outcome'
    | 'amountCents'
    | 'depositFilter'
    | 'cardCount'
    | 'description'
    | 'effectiveFrom'
    | 'month'
    | 'form',
    string
  >
>;
export type ConditionFailure = { ok: false; errors: ConditionErrors };
export type SaveConditionResult = { ok: true; id: string } | ConditionFailure;
export type ConditionActionResult = { ok: true } | ConditionFailure;

// ---------- 行 → 纯函数的形状 ----------

type ConditionRow = typeof accountCondition.$inferSelect;

function toStoredCondition(r: ConditionRow): StoredCondition {
  const common = {
    id: r.id,
    accountId: r.accountId,
    outcome: r.outcome,
    effectiveFrom: r.effectiveFrom,
    disabledFrom: r.disabledFrom,
    createdAt: r.createdAt,
  };
  switch (r.type) {
    case 'min_deposit':
    case 'linked_min_deposit':
      return {
        ...common,
        type: r.type,
        amountCents: r.amountCents!,
        depositFilter: r.depositFilter!,
      };
    case 'linked_card_count':
      return { ...common, type: r.type, cardCount: r.cardCount! };
    case 'other':
      return { ...common, type: r.type, description: r.description! };
    case 'no_withdrawal':
    case 'balance_growth':
      return { ...common, type: r.type };
  }
}

const isLinkedType = (type: ConditionType) =>
  type === 'linked_min_deposit' || type === 'linked_card_count';

// ---------- 交易 ----------

type LoadedTx = Omit<ConditionTx, 'counterpartyAccountId'> & {
  rawDescription: string;
  pairAccountId: string | null;
};

// 每个账户只要 date > after 的交易，一次查完。拆分上的 Bank fees、Interest 在 SQL 里按交易合计
async function loadConditionTxs(
  ctx: HouseholdContext,
  after: Map<string, string>,
  bankFeeId: string | null,
  interestId: string | null,
): Promise<LoadedTx[]> {
  if (after.size === 0) return [];
  const hh = ctx.householdId;
  const pair = alias(transaction, 'pair');
  const splitSum = (categoryId: string | null) =>
    categoryId === null
      ? sql<number>`0`
      : sql<number>`coalesce(sum(case when ${transactionSplit.categoryId} = ${categoryId} then ${transactionSplit.amountCents} else 0 end), 0)`.mapWith(
          Number,
        );
  return db
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      date: transaction.date,
      amountCents: transaction.amountCents,
      status: transaction.status,
      transferStatus: transaction.transferStatus,
      rawDescription: transaction.rawDescription,
      merchant: transaction.merchant,
      createdAt: transaction.createdAt,
      pairAccountId: pair.accountId,
      bankFeeCents: splitSum(bankFeeId),
      interestCents: splitSum(interestId),
    })
    .from(transaction)
    .leftJoin(
      transactionSplit,
      and(eq(transactionSplit.transactionId, transaction.id), eq(transactionSplit.householdId, hh)),
    )
    .leftJoin(pair, and(eq(pair.id, transaction.transferPairId), eq(pair.householdId, hh)))
    .where(
      and(
        eq(transaction.householdId, hh),
        or(
          ...[...after].map(([accountId, date]) =>
            and(eq(transaction.accountId, accountId), gt(transaction.date, date)),
          ),
        ),
      ),
    )
    .groupBy(transaction.id, pair.accountId);
}

// R24.6：每个账户最晚一笔 confirmed 交易的日期。不限 13 个月，所以单独查
async function loadLatestConfirmed(
  ctx: HouseholdContext,
  accountIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (accountIds.length === 0) return result;
  const rows = await db
    .select({ accountId: transaction.accountId, date: max(transaction.date) })
    .from(transaction)
    .where(
      and(
        eq(transaction.householdId, ctx.householdId),
        eq(transaction.status, 'confirmed'),
        inArray(transaction.accountId, accountIds),
      ),
    )
    .groupBy(transaction.accountId);
  for (const r of rows) if (r.date !== null) result.set(r.accountId, r.date);
  return result;
}

async function findBankFeeCategoryId(ctx: HouseholdContext): Promise<string | null> {
  const [row] = await db
    .select({ id: category.id })
    .from(category)
    .where(and(eq(category.householdId, ctx.householdId), eq(category.systemKey, 'bank_fee')));
  return row?.id ?? null;
}

// ---------- 进度和历史（R24.5 – R24.10） ----------

// 所有没归档账户的条件：本月和最近 12 个月的结果、月费校验、每月利息、首页提示
export async function getConditionProgress(
  ctx: HouseholdContext,
  today: string,
): Promise<ConditionProgress> {
  const hh = ctx.householdId;
  // 家庭所有账户，含归档的：找关联账户、对方账户名、R6.1 重跑
  const accounts = await db
    .select({
      id: financialAccount.id,
      name: financialAccount.name,
      bank: financialAccount.bank,
      type: financialAccount.type,
      defaultMemberId: financialAccount.defaultMemberId,
      numberSuffix: financialAccount.numberSuffix,
      linkedAccountId: financialAccount.linkedAccountId,
      isArchived: financialAccount.isArchived,
    })
    .from(financialAccount)
    .where(eq(financialAccount.householdId, hh))
    .orderBy(financialAccount.createdAt, financialAccount.name);
  const active = new Set(accounts.filter((a) => !a.isArchived).map((a) => a.id));

  // R24.1：本账户归档了 → 它的条件都不判断、不显示、不提示
  const conditionRows = await db
    .select()
    .from(accountCondition)
    .where(eq(accountCondition.householdId, hh))
    .orderBy(accountCondition.createdAt, accountCondition.id);
  const conditions = conditionRows.filter((r) => active.has(r.accountId)).map(toStoredCondition);
  if (conditions.length === 0) return { accounts: [], reminder: null };

  // 看的账户：配条件的账户 + 关联类型的关联账户（按现在的关联，R24.1）
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const watchedIds = new Set<string>();
  for (const c of conditions) {
    watchedIds.add(c.accountId);
    const linkedId = byId.get(c.accountId)?.linkedAccountId;
    if (isLinkedType(c.type) && linkedId) watchedIds.add(linkedId);
  }
  const watched = [...watchedIds];

  const [anchors, latest, bankFeeId, interestId, checks] = await Promise.all([
    loadAnchors(db, ctx, watched),
    loadLatestConfirmed(ctx, watched),
    findBankFeeCategoryId(ctx),
    findInterestCategoryId(db, ctx),
    db
      .select({
        conditionId: accountConditionCheck.conditionId,
        month: accountConditionCheck.month,
        isMet: accountConditionCheck.isMet,
      })
      .from(accountConditionCheck)
      .where(
        and(
          eq(accountConditionCheck.householdId, hh),
          inArray(
            accountConditionCheck.conditionId,
            conditions.map((c) => c.id),
          ),
        ),
      ),
  ]);

  // 交易从最近 12 个月的第一天查起；balance_growth 的账户往前到上月末之前最近的锚点（R24.4）
  const historyStart = lastTwelveMonths(today)[0].start;
  const defaultAfter = addDays(historyStart, -1);
  const growthAccounts = new Set(
    conditions.filter((c) => c.type === 'balance_growth').map((c) => c.accountId),
  );
  const after = new Map<string, string>();
  for (const id of watched) {
    const before = growthAccounts.has(id)
      ? pickAnchor((anchors.get(id) ?? []).filter((a) => a.date <= defaultAfter))
      : null;
    after.set(id, before?.date ?? defaultAfter);
  }
  const loaded = await loadConditionTxs(ctx, after, bankFeeId, interestId);

  // R24.3 对方账户
  const ruleAccounts: RuleAccount[] = accounts;
  const txsByAccount = new Map<string, ConditionTx[]>(watched.map((id) => [id, []]));
  for (const t of loaded) {
    const { rawDescription, pairAccountId, ...rest } = t;
    const counterpartyAccountId = resolveCounterparty(
      {
        accountId: t.accountId,
        transferStatus: t.transferStatus,
        pairAccountId,
        maskedDescription: rawDescription,
      },
      ruleAccounts,
    );
    txsByAccount.get(t.accountId)?.push({ ...rest, counterpartyAccountId });
  }
  const allTxs = [...txsByAccount.values()].flat();

  // R24.6 截至：当前锚点日期和最晚一笔 confirmed 交易
  const conditionAccounts: ConditionAccount[] = accounts.map((a) => {
    const anchorDate = pickAnchor(anchors.get(a.id) ?? [])?.date ?? null;
    const latestDate = latest.get(a.id);
    return {
      id: a.id,
      name: a.name,
      linkedAccountId: a.linkedAccountId,
      archived: a.isArchived,
      asOf: dataAsOf(anchorDate, latestDate ? [{ date: latestDate, status: 'confirmed' }] : []),
    };
  });
  const conditionAccountById = new Map(conditionAccounts.map((a) => [a.id, a]));

  const manualChecks = new Map<string, ManualCheck>(
    checks.map((c) => [`${c.conditionId}|${c.month}`, c.isMet ? 'met' : 'failed']),
  );

  const thisMonthStart = startOfMonth(today);
  const reminderItems: ReminderItem[] = [];
  const result: AccountConditionProgress[] = [];
  for (const a of accounts) {
    const own = conditions.filter((c) => c.accountId === a.id);
    if (own.length === 0) continue;
    const account = conditionAccountById.get(a.id)!;
    const ownTxs = txsByAccount.get(a.id) ?? [];
    const ownAnchors: StoredAnchor[] = anchors.get(a.id) ?? [];

    const history = monthsForHistory(own, today).map((month): ConditionMonth => {
      const judged = own.filter((c) => isJudgedIn(c, month));
      const results = judged.map((c) =>
        evaluateCondition(c, {
          account,
          accounts: conditionAccounts,
          month,
          today,
          transactions: allTxs,
          anchors: ownAnchors,
          manualCheck: manualChecks.get(`${c.id}|${month}`) ?? null,
        }),
      );
      const summary = summarizeAccountMonth(judged, results);
      const end = endOfMonth(month);
      const interestCents = ownTxs
        .filter((t) => t.date >= month && t.date <= end)
        .reduce((s, t) => s + t.interestCents, 0);
      return {
        month,
        results,
        summary,
        feeMismatchCents: feeMismatch(summary, ownTxs, month),
        interestCents,
      };
    });

    const current = history.find((m) => m.month === thisMonthStart && m.results.length > 0) ?? null;
    if (current) {
      for (const r of current.results) reminderItems.push({ accountName: a.name, result: r });
    }
    result.push({
      accountId: a.id,
      accountName: a.name,
      conditions: own,
      thisMonth: current,
      history,
    });
  }

  return { accounts: result, reminder: homeReminder(reminderItems, today) };
}

// ---------- 配置（R24.1） ----------

// 设置页只列在用的条件（disabled_from 是 null），归档账户的不列。按建的先后
export async function listActiveConditions(ctx: HouseholdContext): Promise<StoredCondition[]> {
  const rows = await db
    .select({ condition: accountCondition })
    .from(accountCondition)
    .innerJoin(
      financialAccount,
      and(
        eq(financialAccount.id, accountCondition.accountId),
        eq(financialAccount.householdId, ctx.householdId),
      ),
    )
    .where(
      and(
        eq(accountCondition.householdId, ctx.householdId),
        isNull(accountCondition.disabledFrom),
        eq(financialAccount.isArchived, false),
      ),
    )
    .orderBy(accountCondition.createdAt, accountCondition.id);
  return rows.map((r) => toStoredCondition(r.condition));
}

const paramsSchema = z.object({
  type: z.enum(CONDITION_TYPES),
  outcome: z.enum(CONDITION_OUTCOMES),
  amountCents: z.number().nullish(),
  depositFilter: z.enum(DEPOSIT_FILTERS).nullish(),
  cardCount: z.number().nullish(),
  description: z.string().nullish(),
});

const createSchema = paramsSchema.extend({
  accountId: z.uuid(),
  effectiveFrom: z.iso.date(), // 这个月里任意一天，存月初
});

export type ConditionParamsInput = z.input<typeof paramsSchema>;
export type CreateConditionInput = z.input<typeof createSchema>;

const MAX_INT = 2147483647;
const isPositiveInt = (n: number | null | undefined, min: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= MAX_INT;

function shapeErrors(error: z.ZodError): ConditionFailure {
  const errors: ConditionErrors = {};
  for (const issue of error.issues) {
    const key = (issue.path[0] ?? 'form') as keyof ConditionErrors;
    errors[key] ??= '参数不合法';
  }
  return { ok: false, errors };
}

type ConditionValues = {
  type: ConditionType;
  outcome: ConditionOutcome;
  amountCents: number | null;
  depositFilter: DepositFilter | null;
  cardCount: number | null;
  description: string | null;
};

// R24.1 校验 #3 – #6，按顺序，第一条不过就返回。只留这个类型用得到的参数
function checkParams(
  p: z.output<typeof paramsSchema>,
  linkedAccountId: string | null,
): { ok: true; values: ConditionValues } | ConditionFailure {
  if (isLinkedType(p.type) && linkedAccountId === null) {
    return { ok: false, errors: { type: '这个账户还没有设置关联账户' } };
  }
  const values: ConditionValues = {
    type: p.type,
    outcome: p.outcome,
    amountCents: null,
    depositFilter: null,
    cardCount: null,
    description: null,
  };
  switch (p.type) {
    case 'min_deposit':
    case 'linked_min_deposit':
      if (!isPositiveInt(p.amountCents, 1))
        return { ok: false, errors: { amountCents: '金额要大于 $0' } };
      if (!p.depositFilter) return { ok: false, errors: { depositFilter: '参数不合法' } };
      return {
        ok: true,
        values: { ...values, amountCents: p.amountCents, depositFilter: p.depositFilter },
      };
    case 'linked_card_count':
      if (!isPositiveInt(p.cardCount, 1))
        return { ok: false, errors: { cardCount: '笔数至少 1 笔' } };
      return { ok: true, values: { ...values, cardCount: p.cardCount } };
    case 'other': {
      const description = p.description?.trim() ?? '';
      if (description === '') return { ok: false, errors: { description: '写一下条件是什么' } };
      return { ok: true, values: { ...values, description } };
    }
    case 'no_withdrawal':
    case 'balance_growth':
      return { ok: true, values };
  }
}

// R24.1 #1、#2：本家庭、没归档。锁住账户，免得同时改关联
async function lockAccount(
  tx: DbTx,
  ctx: HouseholdContext,
  accountId: string,
): Promise<{ ok: true; linkedAccountId: string | null } | ConditionFailure> {
  const [account] = await tx
    .select({
      isArchived: financialAccount.isArchived,
      linkedAccountId: financialAccount.linkedAccountId,
    })
    .from(financialAccount)
    .where(
      and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)),
    )
    .for('update');
  if (!account) return { ok: false, errors: { accountId: '找不到这个账户' } };
  if (account.isArchived) return { ok: false, errors: { accountId: '归档的账户不能加条件' } };
  return { ok: true, linkedAccountId: account.linkedAccountId };
}

// R24.1 添加：effective_from 默认本月，可以更早，不能晚于本月
export async function createCondition(
  ctx: HouseholdContext,
  input: CreateConditionInput,
  today: string,
): Promise<SaveConditionResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return shapeErrors(parsed.error);
  const { accountId, effectiveFrom, ...params } = parsed.data;

  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, ctx, accountId);
    if (!account.ok) return account;
    const checked = checkParams(params, account.linkedAccountId);
    if (!checked.ok) return checked;
    const month = startOfMonth(effectiveFrom);
    if (month > startOfMonth(today))
      return { ok: false, errors: { effectiveFrom: '生效月份不能晚于本月' } };

    const [row] = await tx
      .insert(accountCondition)
      .values({
        householdId: ctx.householdId,
        accountId,
        ...checked.values,
        effectiveFrom: month,
        createdBy: ctx.userId,
      })
      .returning({ id: accountCondition.id });
    return { ok: true, id: row.id };
  });
}

const notFound: ConditionFailure = { ok: false, errors: { form: '找不到这个条件' } };

// 在用的（disabled_from 是 null）、本家庭的条件，锁住
async function lockActiveCondition(tx: DbTx, ctx: HouseholdContext, id: string) {
  const [row] = await tx
    .select()
    .from(accountCondition)
    .where(
      and(
        eq(accountCondition.id, id),
        eq(accountCondition.householdId, ctx.householdId),
        isNull(accountCondition.disabledFrom),
      ),
    )
    .for('update');
  return row ?? null;
}

// R24.1 修改：旧的 disabled_from = 本月，建一条新的 effective_from = 本月。同一个事务
// 账户不能换；返回新条件的 id
export async function updateCondition(
  ctx: HouseholdContext,
  id: string,
  input: ConditionParamsInput,
  today: string,
): Promise<SaveConditionResult> {
  if (!z.uuid().safeParse(id).success) return notFound;
  const parsed = paramsSchema.safeParse(input);
  if (!parsed.success) return shapeErrors(parsed.error);

  return db.transaction(async (tx) => {
    const old = await lockActiveCondition(tx, ctx, id);
    if (old === null) return notFound;
    const account = await lockAccount(tx, ctx, old.accountId);
    if (!account.ok) return account;
    const checked = checkParams(parsed.data, account.linkedAccountId);
    if (!checked.ok) return checked;

    const month = startOfMonth(today);
    await tx
      .update(accountCondition)
      .set({ disabledFrom: month })
      .where(eq(accountCondition.id, old.id));
    const [row] = await tx
      .insert(accountCondition)
      .values({
        householdId: ctx.householdId,
        accountId: old.accountId,
        ...checked.values,
        effectiveFrom: month,
        createdBy: ctx.userId,
      })
      .returning({ id: accountCondition.id });
    return { ok: true, id: row.id };
  });
}

// R24.1 删除：disabled_from = 本月。后台不真删
export async function deactivateCondition(
  ctx: HouseholdContext,
  id: string,
  today: string,
): Promise<ConditionActionResult> {
  if (!z.uuid().safeParse(id).success) return notFound;
  const updated = await db
    .update(accountCondition)
    .set({ disabledFrom: startOfMonth(today) })
    .where(
      and(
        eq(accountCondition.id, id),
        eq(accountCondition.householdId, ctx.householdId),
        isNull(accountCondition.disabledFrom),
      ),
    )
    .returning({ id: accountCondition.id });
  return updated.length === 0 ? notFound : { ok: true };
}

// ---------- "其他"的手动勾（R24.7） ----------

// isMet：true 满足了 / false 没满足 / null 清掉（删那一行，回到还没勾）
// 只能勾 other、这个条件在判断的月份、不晚于本月；账户归档了当成找不到
export async function setManualCheck(
  ctx: HouseholdContext,
  conditionId: string,
  month: string,
  isMet: boolean | null,
  today: string,
): Promise<ConditionActionResult> {
  if (!z.uuid().safeParse(conditionId).success) return notFound;
  if (!z.iso.date().safeParse(month).success) return { ok: false, errors: { month: '参数不合法' } };
  const m = startOfMonth(month);

  const [row] = await db
    .select({
      type: accountCondition.type,
      effectiveFrom: accountCondition.effectiveFrom,
      disabledFrom: accountCondition.disabledFrom,
      isArchived: financialAccount.isArchived,
    })
    .from(accountCondition)
    .innerJoin(
      financialAccount,
      and(
        eq(financialAccount.id, accountCondition.accountId),
        eq(financialAccount.householdId, ctx.householdId),
      ),
    )
    .where(
      and(eq(accountCondition.id, conditionId), eq(accountCondition.householdId, ctx.householdId)),
    );
  if (!row || row.isArchived || row.type !== 'other') return notFound;
  if (m > startOfMonth(today) || !isJudgedIn(row, m)) {
    return { ok: false, errors: { month: '这个月不能勾' } };
  }

  if (isMet === null) {
    await db
      .delete(accountConditionCheck)
      .where(
        and(
          eq(accountConditionCheck.householdId, ctx.householdId),
          eq(accountConditionCheck.conditionId, conditionId),
          eq(accountConditionCheck.month, m),
        ),
      );
    return { ok: true };
  }
  await db
    .insert(accountConditionCheck)
    .values({ householdId: ctx.householdId, conditionId, month: m, isMet, createdBy: ctx.userId })
    .onConflictDoUpdate({
      target: [accountConditionCheck.conditionId, accountConditionCheck.month],
      set: { isMet, createdBy: ctx.userId, updatedAt: sql`now()` },
    });
  return { ok: true };
}
