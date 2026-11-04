// R25 目标和应急金的数据访问（M11-4）
// 进度、每月要存、预计达成、应急金金额都用 src/lib/rules/goals.ts 的纯函数实时算，这里只查数据
// 余额复用 balances.ts 的锚点和交易合计，月均复用 monthly-average.ts 的查询。每个查询都带 household_id
import { and, asc, eq, inArray, isNotNull, max, min, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import {
  category,
  financialAccount,
  goal,
  household,
  transaction,
  transactionSplit,
} from '@/db/schema';
import { accountNetInflow, pickAnchor, type AccountNetInflow } from '@/lib/rules/balance';
import {
  actualSavings,
  nextCycle,
  affordability,
  emergencyTarget,
  fillByPriority,
  goalMonthlyRequired,
  goalSpend,
  monthsCovered,
  projectedCompletion,
  type Affordability,
  type Goal,
  type GoalAccountBalance,
  type GoalKind,
  type GoalProgress,
  type GoalRepeat,
  type GoalSpend,
  type GoalStatus,
  type Projection,
} from '@/lib/rules/goals';
import {
  averageWindow,
  monthlyAverage,
  type AverageWindow,
  type MonthlyAverage,
} from '@/lib/rules/monthly-average';
import { canMarkOneOff } from '@/lib/rules/one-off';
import { addDays } from '@/lib/rules/periods';
import {
  balanceFrom,
  loadAnchors,
  loadDayTotals,
  type DayTotal,
  type StoredAnchor,
} from './balances';
import type { HouseholdContext } from './context';
import {
  firstTransactionDate,
  getBudgetAverage,
  loadCategories,
  loadMembers,
  loadSplits,
} from './monthly-average';
import type { DbTx } from './transactions';

type Tx = DbTx | typeof db;

// ---------- 返回的形状 ----------

export type GoalRecord = {
  id: string;
  name: string;
  kind: GoalKind;
  recurrence: GoalRepeat;
  targetCents: number | null; // 存的值；应急金是 null，算出来的在 progress.targetCents
  targetDate: string | null;
  account: { id: string; name: string; isArchived: boolean } | null;
  priority: number;
  isEmergency: boolean;
  emergencyMonths: number | null;
  isPinned: boolean;
  status: GoalStatus;
  doneAt: Date | null;
  prevGoalId: string | null;
};

// R25.11 点开看挂的交易
export type LinkedSplit = {
  splitId: string;
  transactionId: string;
  date: string;
  merchant: string;
  amountCents: number;
};

export type ActiveGoal = GoalRecord & {
  progress: GoalProgress;
  monthlyRequiredCents: number | null; // null：没有日期、应急金算不出金额、已过期
  overdue: boolean; // R25.2 "已过期，还差 $X"
  projection: Projection;
  spend: GoalSpend | null; // 只有 spend
  linked: LinkedSplit[];
};

export type EmergencyGoal = ActiveGoal & {
  average: MonthlyAverage | null; // 近 12 个月总月均，"月均 $X × N 个月"
  monthsCoveredTenths: number | null; // 能撑几个月 × 10；null 显示"—"或不显示（没进度）
};

export type DoneGoal = GoalRecord & { spend: GoalSpend; linked: LinkedSplit[] };

export type GoalsOverview = {
  emergency: EmergencyGoal | null;
  active: ActiveGoal[]; // 不含应急金，按优先级
  done: DoneGoal[]; // 按完成时间从新到旧
  affordability: Affordability & { months: number }; // months：实际每月存下"基于 n 个月"
};

// ---------- 查询 ----------

async function loadGoals(tx: Tx, ctx: HouseholdContext): Promise<GoalRecord[]> {
  const rows = await tx
    .select({
      id: goal.id,
      name: goal.name,
      kind: goal.kind,
      recurrence: goal.recurrence,
      targetCents: goal.targetCents,
      targetDate: goal.targetDate,
      accountId: financialAccount.id,
      accountName: financialAccount.name,
      accountIsArchived: financialAccount.isArchived,
      priority: goal.priority,
      isEmergency: goal.isEmergency,
      emergencyMonths: goal.emergencyMonths,
      isPinned: goal.isPinned,
      status: goal.status,
      doneAt: goal.doneAt,
      prevGoalId: goal.prevGoalId,
    })
    .from(goal)
    .leftJoin(
      financialAccount,
      and(
        eq(financialAccount.id, goal.accountId),
        eq(financialAccount.householdId, ctx.householdId),
      ),
    )
    .where(eq(goal.householdId, ctx.householdId))
    .orderBy(asc(goal.priority), asc(goal.id));
  return rows.map(({ accountId, accountName, accountIsArchived, ...g }) => ({
    ...g,
    account:
      accountId === null
        ? null
        : { id: accountId, name: accountName!, isArchived: accountIsArchived! },
  }));
}

function toRule(g: GoalRecord): Goal {
  return {
    id: g.id,
    kind: g.kind,
    repeat: g.recurrence,
    targetCents: g.targetCents,
    targetDate: g.targetDate,
    accountId: g.account?.id ?? null,
    priority: g.priority,
    emergencyMonths: g.isEmergency ? g.emergencyMonths : null,
    status: g.status,
  };
}

// 本家庭所有挂了目标的拆分（含 done 的目标），R25.7 实际和挂的交易列表
async function loadLinkedSplits(
  tx: Tx,
  ctx: HouseholdContext,
): Promise<(LinkedSplit & { goalId: string })[]> {
  const rows = await tx
    .select({
      splitId: transactionSplit.id,
      transactionId: transaction.id,
      goalId: transactionSplit.goalId,
      date: transaction.date,
      merchant: transaction.merchant,
      amountCents: transactionSplit.amountCents,
    })
    .from(transactionSplit)
    .innerJoin(
      transaction,
      and(
        eq(transaction.id, transactionSplit.transactionId),
        eq(transaction.householdId, ctx.householdId),
      ),
    )
    .where(
      and(eq(transactionSplit.householdId, ctx.householdId), isNotNull(transactionSplit.goalId)),
    )
    .orderBy(asc(transaction.date), asc(transactionSplit.id));
  return rows.map((r) => ({ ...r, goalId: r.goalId! }));
}

// R25.4 起点：每个账户最早一笔交易（任何分类、任何状态）
async function accountFirstDates(
  tx: Tx,
  ctx: HouseholdContext,
  accountIds: string[],
): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  const rows = await tx
    .select({ accountId: transaction.accountId, first: min(transaction.date) })
    .from(transaction)
    .where(
      and(eq(transaction.householdId, ctx.householdId), inArray(transaction.accountId, accountIds)),
    )
    .groupBy(transaction.accountId);
  return new Map(rows.map((r) => [r.accountId, r.first!]));
}

// R23.2 可用余额（R25.3），withInflow 时再加 R25.4 的账户月净流入
// 锚点之后和净流入窗口里的交易合计用一次 loadDayTotals 查完
async function loadAccountFigures(
  tx: Tx,
  ctx: HouseholdContext,
  goals: readonly GoalRecord[],
  today: string,
  withInflow: boolean,
): Promise<{
  balances: Map<string, GoalAccountBalance>;
  inflows: Map<string, AccountNetInflow | null>;
}> {
  const accounts = new Map<string, boolean>();
  for (const g of goals)
    if (g.status === 'active' && g.account) accounts.set(g.account.id, g.account.isArchived);
  const live = [...accounts].filter(([, archived]) => !archived).map(([id]) => id);

  const [anchors, firstDates] = await Promise.all([
    loadAnchors(tx, ctx, live),
    withInflow ? accountFirstDates(tx, ctx, live) : Promise.resolve(new Map<string, string>()),
  ]);

  const anchorOf = new Map<string, StoredAnchor>();
  const windows = new Map<string, AverageWindow>();
  const since = new Map<string, string>();
  for (const id of live) {
    const anchor = pickAnchor(anchors.get(id) ?? []);
    if (anchor === null) continue; // 没锚点：没有进度，也不估（R25.3、R25.4）
    anchorOf.set(id, anchor);
    let from = anchor.date;
    if (withInflow) {
      const window = averageWindow(today, firstDates.get(id) ?? null, 3);
      windows.set(id, window);
      if (window.range) {
        const before = addDays(window.range.start, -1);
        if (before < from) from = before;
      }
    }
    since.set(id, from);
  }
  const days = await loadDayTotals(tx, ctx, since);

  const balances = new Map<string, GoalAccountBalance>();
  const inflows = new Map<string, AccountNetInflow | null>();
  for (const [id, archived] of accounts) {
    const anchor = anchorOf.get(id);
    const d: DayTotal[] = days.get(id) ?? [];
    balances.set(id, { archived, balance: anchor ? balanceFrom(anchor, d) : null });
    const window = windows.get(id);
    if (window) {
      const txs = d.map((t) => ({ date: t.date, status: t.status, amountCents: t.cents }));
      inflows.set(id, accountNetInflow(txs, window));
    }
  }
  return { balances, inflows };
}

// ---------- getGoals ----------

// R25.2 到 R25.7、R25.11：/goals 页要的全部。不跟看板筛选（全家）
export async function getGoals(ctx: HouseholdContext, today: string): Promise<GoalsOverview> {
  const [records, linkedAll, firstDate, categories, members] = await Promise.all([
    loadGoals(db, ctx),
    loadLinkedSplits(db, ctx),
    firstTransactionDate(ctx),
    loadCategories(ctx),
    loadMembers(ctx),
  ]);

  // R25.6 月均用近 12 个月，R25.5 实际存下用近 3 个月，3 个月在 12 个月里面，一次查
  const window12 = averageWindow(today, firstDate, 12);
  const window3 = averageWindow(today, firstDate, 3);
  const [figures, splits] = await Promise.all([
    loadAccountFigures(db, ctx, records, today, true),
    window12.range
      ? loadSplits(ctx, window12.range.start, window12.range.end)
      : Promise.resolve([]),
  ]);

  const average = monthlyAverage(splits, categories, members, window12);
  const emergencyRecord = records.find((g) => g.isEmergency && g.status === 'active') ?? null;
  const emergencyTargetCents = emergencyRecord
    ? emergencyTarget(average, emergencyRecord.emergencyMonths!)
    : null;

  const rules = records.map(toRule);
  const progress = fillByPriority(rules, figures.balances, emergencyTargetCents);
  const required = goalMonthlyRequired(rules, progress, today);
  const projections = projectedCompletion(
    rules,
    progress,
    figures.balances,
    figures.inflows,
    today,
  );
  const savings = actualSavings(splits, window3, categories);

  const linkedByGoal = new Map<string, LinkedSplit[]>();
  for (const { goalId, ...s } of linkedAll) {
    const list = linkedByGoal.get(goalId) ?? [];
    list.push(s);
    linkedByGoal.set(goalId, list);
  }
  const linkedOf = (id: string) => linkedByGoal.get(id) ?? [];
  const progressOf = new Map(progress.map((p) => [p.goalId, p]));

  const activeOf = (g: GoalRecord): ActiveGoal => {
    const p = progressOf.get(g.id)!;
    return {
      ...g,
      progress: p,
      monthlyRequiredCents: required.get(g.id) ?? null,
      overdue: g.targetDate !== null && g.targetDate < today && !p.reached,
      projection: projections.get(g.id)!,
      spend: g.kind === 'spend' ? goalSpend(g, linkedAll) : null,
      linked: linkedOf(g.id),
    };
  };

  const active = records.filter((g) => g.status === 'active' && !g.isEmergency).map(activeOf);
  const emergency: EmergencyGoal | null = emergencyRecord
    ? (() => {
        const e = activeOf(emergencyRecord);
        const filled = e.progress.filledCents;
        return {
          ...e,
          average,
          monthsCoveredTenths: filled === null ? null : monthsCovered(filled, average),
        };
      })()
    : null;
  const done = records
    .filter((g) => g.status === 'done')
    .sort((a, b) => b.doneAt!.getTime() - a.doneAt!.getTime())
    .map((g) => ({ ...g, spend: goalSpend(g, linkedAll), linked: linkedOf(g.id) }));

  return {
    emergency,
    active,
    done,
    affordability: { ...affordability(required, savings), months: window3.months },
  };
}

// ---------- 新建、修改（R25.1） ----------

// 字段类型不对算"输入不对"；R25.1 的 11 条在 checkGoal 里按顺序查
const goalInputSchema = z.object({
  name: z.string(),
  kind: z.enum(['keep', 'spend']),
  recurrence: z.enum(['once', 'yearly']),
  targetCents: z.number().int().max(2147483647).nullable(),
  targetDate: z.iso.date().nullable(),
  accountId: z.uuid().nullable(),
  emergencyMonths: z.number().nullable(), // 只有应急金用，不是应急金时忽略
  isPinned: z.boolean(),
});

export type GoalInput = z.input<typeof goalInputSchema>;
export type GoalField =
  'name' | 'targetCents' | 'recurrence' | 'targetDate' | 'emergencyMonths' | 'accountId' | 'form';
export type GoalFailure = { ok: false; field: GoalField; message: string };
export type GoalWriteResult = { ok: true; goalId: string } | GoalFailure;

const fail = (field: GoalField, message: string): GoalFailure => ({ ok: false, field, message });
const INVALID = fail('form', '输入不对');
const GOAL_NOT_FOUND = fail('form', '找不到这个目标');
const EMERGENCY_EXISTS = fail('form', '已经有应急金目标了');

// R25.1：去首尾空格、多个空格合成一个
export function normalizeGoalName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

type GoalValues = Omit<
  typeof goal.$inferInsert,
  'id' | 'householdId' | 'createdBy' | 'priority' | 'status'
>;

// 应急金：keep、once、不填金额和日期（R25.1）；不是应急金：不存月数
function toValues(input: z.output<typeof goalInputSchema>, isEmergency: boolean): GoalValues {
  return isEmergency
    ? {
        name: normalizeGoalName(input.name),
        kind: 'keep',
        recurrence: 'once',
        targetCents: null,
        targetDate: null,
        accountId: input.accountId,
        isEmergency: true,
        emergencyMonths: input.emergencyMonths,
        isPinned: input.isPinned,
      }
    : {
        name: normalizeGoalName(input.name),
        kind: input.kind,
        recurrence: input.recurrence,
        targetCents: input.targetCents,
        targetDate: input.targetDate,
        accountId: input.accountId,
        isEmergency: false,
        emergencyMonths: null,
        isPinned: input.isPinned,
      };
}

// R25.1 第 3 条：active 里不区分大小写，自己不算（exclude）
async function nameTaken(
  tx: Tx,
  ctx: HouseholdContext,
  name: string,
  exclude: string[],
): Promise<boolean> {
  const rows = await tx
    .select({ id: goal.id })
    .from(goal)
    .where(
      and(
        eq(goal.householdId, ctx.householdId),
        eq(goal.status, 'active'),
        sql`lower(${goal.name}) = lower(${name})`,
        ...exclude.map((id) => ne(goal.id, id)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// R25.1 第 9 到 11 条：账户改变时才查，不挂（null）不查
async function checkAccount(
  tx: Tx,
  ctx: HouseholdContext,
  accountId: string,
): Promise<GoalFailure | null> {
  const [account] = await tx
    .select({ bank: financialAccount.bank, isArchived: financialAccount.isArchived })
    .from(financialAccount)
    .where(
      and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)),
    );
  if (!account) return fail('accountId', '找不到这个账户');
  if (account.isArchived) return fail('accountId', '不能挂已归档的账户');
  if (account.bank === 'cash') return fail('accountId', '不能挂现金账户');
  return null;
}

// R25.1 保存时的校验，按顺序，第一条不过就返回
async function checkGoal(
  tx: Tx,
  ctx: HouseholdContext,
  values: GoalValues,
  self: { id: string; accountId: string | null } | null, // null = 新建
): Promise<GoalFailure | null> {
  const name = values.name;
  if (name.length === 0) return fail('name', '请填名字');
  if (name.length > 50) return fail('name', '名字最多 50 个字');
  if (await nameTaken(tx, ctx, name, self ? [self.id] : [])) return fail('name', '已有同名的目标');
  if (!values.isEmergency && (values.targetCents == null || values.targetCents <= 0)) {
    return fail('targetCents', '目标金额要大于 0');
  }
  if (values.kind === 'keep' && values.recurrence === 'yearly') {
    return fail('recurrence', '只有要花掉的目标能每年重复');
  }
  if (values.recurrence === 'yearly' && values.targetDate == null) {
    return fail('targetDate', '每年重复的目标要填日期');
  }
  if (values.isEmergency) {
    const m = values.emergencyMonths;
    if (m == null || !Number.isInteger(m) || m < 1 || m > 24)
      return fail('emergencyMonths', '月数是 1 到 24');
  }
  if (values.isEmergency && self === null) {
    const [existing] = await tx
      .select({ id: goal.id })
      .from(goal)
      .where(and(eq(goal.householdId, ctx.householdId), eq(goal.isEmergency, true)));
    if (existing) return EMERGENCY_EXISTS;
  }
  const accountId = values.accountId ?? null;
  if (accountId !== null && accountId !== (self?.accountId ?? null)) {
    return checkAccount(tx, ctx, accountId);
  }
  return null;
}

// 新建排最后、上下移动都要读最大优先级再写，锁住家庭这一行，两个人同时操作时不重复
async function lockHousehold(tx: DbTx, ctx: HouseholdContext): Promise<void> {
  await tx
    .select({ id: household.id })
    .from(household)
    .where(eq(household.id, ctx.householdId))
    .for('update');
}

function isEmergencyUniqueViolation(err: unknown): boolean {
  const pgError = (err as { cause?: unknown })?.cause ?? err;
  const { code, constraint } = (pgError ?? {}) as { code?: string; constraint?: string };
  return code === '23505' && constraint === 'goal_household_id_emergency_unique';
}

// R25.1：新建的排最后（含 done 的最大优先级 + 1，第一个是 1）；应急金存 0
export async function createGoal(
  ctx: HouseholdContext,
  input: GoalInput & { isEmergency: boolean },
): Promise<GoalWriteResult> {
  const parsed = goalInputSchema.safeParse(input);
  if (!parsed.success || typeof input.isEmergency !== 'boolean') return INVALID;
  const values = toValues(parsed.data, input.isEmergency);

  try {
    return await db.transaction(async (tx): Promise<GoalWriteResult> => {
      await lockHousehold(tx, ctx);
      const error = await checkGoal(tx, ctx, values, null);
      if (error) return error;
      let priority = 0;
      if (!values.isEmergency) {
        const [row] = await tx
          .select({ top: max(goal.priority) })
          .from(goal)
          .where(eq(goal.householdId, ctx.householdId));
        priority = Math.max(row?.top ?? 0, 0) + 1;
      }
      const [created] = await tx
        .insert(goal)
        .values({ ...values, householdId: ctx.householdId, priority, createdBy: ctx.userId })
        .returning({ id: goal.id });
      return { ok: true, goalId: created.id };
    });
  } catch (err) {
    if (!isEmergencyUniqueViolation(err)) throw err;
    return EMERGENCY_EXISTS;
  }
}

// R25.1：是不是应急金不能改；优先级、状态不在这里改。只改 active 的
// spend 改成 keep 时如果挂了交易，报错（R25.7 只有 spend 能挂）
export async function updateGoal(
  ctx: HouseholdContext,
  goalId: string,
  input: GoalInput,
): Promise<GoalWriteResult> {
  if (!z.uuid().safeParse(goalId).success) return GOAL_NOT_FOUND;
  const parsed = goalInputSchema.safeParse(input);
  if (!parsed.success) return INVALID;

  return db.transaction(async (tx): Promise<GoalWriteResult> => {
    const [current] = await tx
      .select({ isEmergency: goal.isEmergency, accountId: goal.accountId, status: goal.status })
      .from(goal)
      .where(and(eq(goal.id, goalId), eq(goal.householdId, ctx.householdId)))
      .for('update');
    if (!current) return GOAL_NOT_FOUND;
    if (current.status !== 'active') return fail('form', '已完成的目标不能改，先撤销完成');

    const values = toValues(parsed.data, current.isEmergency);
    const error = await checkGoal(tx, ctx, values, { id: goalId, accountId: current.accountId });
    if (error) return error;
    if (values.kind === 'keep' && (await hasLinkedSplits(tx, ctx, goalId))) {
      return fail('form', '挂了交易的目标不能改成存着的');
    }

    await tx
      .update(goal)
      .set(values)
      .where(and(eq(goal.id, goalId), eq(goal.householdId, ctx.householdId)));
    return { ok: true, goalId };
  });
}

async function hasLinkedSplits(tx: Tx, ctx: HouseholdContext, goalId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: transactionSplit.id })
    .from(transactionSplit)
    .where(
      and(eq(transactionSplit.householdId, ctx.householdId), eq(transactionSplit.goalId, goalId)),
    )
    .limit(1);
  return rows.length > 0;
}

// ---------- 改优先级、完成、撤销完成、删除（R25.9） ----------

// R25.9：和相邻的 active 目标交换优先级。应急金不参加；第一个不能上移，最后一个不能下移
export async function moveGoal(
  ctx: HouseholdContext,
  goalId: string,
  direction: 'up' | 'down',
): Promise<GoalWriteResult> {
  if (!z.uuid().safeParse(goalId).success) return GOAL_NOT_FOUND;
  if (direction !== 'up' && direction !== 'down') return INVALID;

  return db.transaction(async (tx): Promise<GoalWriteResult> => {
    await lockHousehold(tx, ctx);
    const list = await tx
      .select({ id: goal.id, priority: goal.priority })
      .from(goal)
      .where(
        and(
          eq(goal.householdId, ctx.householdId),
          eq(goal.status, 'active'),
          eq(goal.isEmergency, false),
        ),
      )
      .orderBy(asc(goal.priority), asc(goal.id));
    const i = list.findIndex((g) => g.id === goalId);
    if (i === -1) return GOAL_NOT_FOUND;
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0) return fail('form', '已经是第一个了');
    if (j >= list.length) return fail('form', '已经是最后一个了');

    const [a, b] = [list[i], list[j]];
    await tx
      .update(goal)
      .set({ priority: b.priority })
      .where(and(eq(goal.id, a.id), eq(goal.householdId, ctx.householdId)));
    await tx
      .update(goal)
      .set({ priority: a.priority })
      .where(and(eq(goal.id, b.id), eq(goal.householdId, ctx.householdId)));
    return { ok: true, goalId };
  });
}

// R25.9：不是应急金的 active 目标都能完成，不要求挂了交易
// yearly 同一个事务里建下一期，返回的 goalId 是下一期；once 返回自己
export async function completeGoal(
  ctx: HouseholdContext,
  goalId: string,
): Promise<GoalWriteResult> {
  if (!z.uuid().safeParse(goalId).success) return GOAL_NOT_FOUND;

  return db.transaction(async (tx): Promise<GoalWriteResult> => {
    const [current] = await tx
      .select()
      .from(goal)
      .where(and(eq(goal.id, goalId), eq(goal.householdId, ctx.householdId)))
      .for('update');
    if (!current) return GOAL_NOT_FOUND;
    if (current.isEmergency) return fail('form', '应急金不能完成');
    if (current.status !== 'active') return fail('form', '这个目标已经完成了');

    await tx
      .update(goal)
      .set({ status: 'done', doneAt: new Date() })
      .where(and(eq(goal.id, goalId), eq(goal.householdId, ctx.householdId)));
    if (current.recurrence !== 'yearly') return { ok: true, goalId };

    // 照抄名字、固定到首页；其他照 nextCycle。不检查账户现在是否归档
    const next = nextCycle({
      id: current.id,
      kind: current.kind,
      repeat: current.recurrence,
      targetCents: current.targetCents,
      targetDate: current.targetDate,
      accountId: current.accountId,
      priority: current.priority,
      emergencyMonths: null,
      status: current.status,
    });
    const [created] = await tx
      .insert(goal)
      .values({
        householdId: ctx.householdId,
        name: current.name,
        kind: next.kind,
        recurrence: next.repeat,
        targetCents: next.targetCents,
        targetDate: next.targetDate,
        accountId: next.accountId,
        priority: next.priority,
        isPinned: current.isPinned,
        prevGoalId: next.prevGoalId,
        createdBy: ctx.userId,
      })
      .returning({ id: goal.id });
    return { ok: true, goalId: created.id };
  });
}

// R25.9：done → active，优先级不变。yearly 先处理自动建的下一期
export async function reopenGoal(ctx: HouseholdContext, goalId: string): Promise<GoalWriteResult> {
  if (!z.uuid().safeParse(goalId).success) return GOAL_NOT_FOUND;

  return db.transaction(async (tx): Promise<GoalWriteResult> => {
    const [current] = await tx
      .select({ name: goal.name, status: goal.status, recurrence: goal.recurrence })
      .from(goal)
      .where(and(eq(goal.id, goalId), eq(goal.householdId, ctx.householdId)))
      .for('update');
    if (!current) return GOAL_NOT_FOUND;
    if (current.status !== 'done') return fail('form', '这个目标还没完成');

    // 找不到下一期（被删了）→ 直接变回 active
    const [next] =
      current.recurrence === 'yearly'
        ? await tx
            .select({ id: goal.id, status: goal.status })
            .from(goal)
            .where(and(eq(goal.householdId, ctx.householdId), eq(goal.prevGoalId, goalId)))
            .for('update')
        : [];
    if (next) {
      if (next.status === 'done') return fail('form', '下一期已经完成了，先撤销下一期');
      if (await hasLinkedSplits(tx, ctx, next.id))
        return fail('form', '下一期已经挂了交易，不能撤销');
    }
    // 下一期马上要删，不算重名。先查完再删：返回错误不会回滚事务
    if (await nameTaken(tx, ctx, current.name, next ? [goalId, next.id] : [goalId])) {
      return fail('form', '已有同名的目标，先改名');
    }

    if (next)
      await tx.delete(goal).where(and(eq(goal.id, next.id), eq(goal.householdId, ctx.householdId)));
    await tx
      .update(goal)
      .set({ status: 'active', doneAt: null })
      .where(and(eq(goal.id, goalId), eq(goal.householdId, ctx.householdId)));
    return { ok: true, goalId };
  });
}

function isGoalLinkedViolation(err: unknown): boolean {
  const pgError = (err as { cause?: unknown })?.cause ?? err;
  const { code, constraint } = (pgError ?? {}) as { code?: string; constraint?: string };
  return code === '23503' && constraint === 'transaction_split_goal_id_goal_id_fk';
}

const GOAL_LINKED = fail('form', '挂了交易的目标不能删，可以点完成');

// R25.9：硬删除。挂了交易的不能删（goal_id 是 restrict，同时挂上时数据库兜底）
// 下一期的 prev_goal_id 由外键 on delete set null 清空
export async function deleteGoal(ctx: HouseholdContext, goalId: string): Promise<GoalWriteResult> {
  if (!z.uuid().safeParse(goalId).success) return GOAL_NOT_FOUND;
  try {
    return await db.transaction(async (tx): Promise<GoalWriteResult> => {
      if (await hasLinkedSplits(tx, ctx, goalId)) return GOAL_LINKED;
      const [row] = await tx
        .delete(goal)
        .where(and(eq(goal.id, goalId), eq(goal.householdId, ctx.householdId)))
        .returning({ id: goal.id });
      return row ? { ok: true, goalId } : GOAL_NOT_FOUND;
    });
  } catch (err) {
    if (!isGoalLinkedViolation(err)) throw err;
    return GOAL_LINKED;
  }
}

// ---------- 挂交易（R25.7） ----------

export type LinkSplitResult = { ok: true } | { ok: false; message: string };

// R25.7：只有支出口径的拆分能挂，只能挂 active 的 spend 目标。挂上时同一个事务里 is_one_off = true
// 校验按 R25.7 的表顺序，改成"不挂"只查第 1 条
// goalId = null 是取消挂，不动 is_one_off。已经挂了别的目标的直接换
export async function linkSplitToGoal(
  ctx: HouseholdContext,
  splitId: string,
  goalId: string | null,
): Promise<LinkSplitResult> {
  const splitNotFound = { ok: false, message: '找不到这笔交易' } as const;
  if (!z.uuid().safeParse(splitId).success) return splitNotFound;
  if (goalId !== null && !z.uuid().safeParse(goalId).success) {
    return { ok: false, message: '找不到这个目标' };
  }

  return db.transaction(async (tx): Promise<LinkSplitResult> => {
    const byId = and(
      eq(transactionSplit.id, splitId),
      eq(transactionSplit.householdId, ctx.householdId),
    );
    const [split] = await tx
      .select({ kind: category.kind, systemKey: category.systemKey })
      .from(transactionSplit)
      .innerJoin(
        category,
        and(
          eq(category.id, transactionSplit.categoryId),
          eq(category.householdId, ctx.householdId),
        ),
      )
      .where(byId)
      .for('update', { of: transactionSplit });
    if (!split) return splitNotFound;

    if (goalId === null) {
      await tx.update(transactionSplit).set({ goalId: null }).where(byId);
      return { ok: true };
    }

    if (!canMarkOneOff(split)) return { ok: false, message: '只有支出能挂到目标' };
    // 锁住目标，和完成、删除不会同时发生
    const [target] = await tx
      .select({ kind: goal.kind, status: goal.status })
      .from(goal)
      .where(and(eq(goal.id, goalId), eq(goal.householdId, ctx.householdId)))
      .for('share');
    if (!target) return { ok: false, message: '找不到这个目标' };
    if (target.kind !== 'spend') return { ok: false, message: '只能挂到要花掉的目标' };
    if (target.status !== 'active') return { ok: false, message: '目标已经完成，不能再挂' };

    await tx.update(transactionSplit).set({ goalId, isOneOff: true }).where(byId);
    return { ok: true };
  });
}

// ---------- 预算总览"还能花"（R25.10） ----------

// R25.10：本月每月要存合计，口径同 getGoals 的 affordability.requiredTotalCents
// 只查目标和余额；月均只在应急金和有日期的目标挂同一个账户时才查（应急金先占钱，R25.3）
export async function getBudgetSpendable(ctx: HouseholdContext, today: string): Promise<number> {
  const records = await loadGoals(db, ctx);
  const dated = records.filter(
    (g) => g.status === 'active' && !g.isEmergency && g.targetDate !== null,
  );
  if (dated.length === 0) return 0;

  const emergency = records.find((g) => g.isEmergency && g.status === 'active') ?? null;
  const sharesAccount =
    emergency?.account != null && dated.some((g) => g.account?.id === emergency.account!.id);

  const [figures, average] = await Promise.all([
    loadAccountFigures(db, ctx, records, today, false),
    sharesAccount ? getBudgetAverage(ctx, today) : Promise.resolve(null),
  ]);
  const emergencyTargetCents = sharesAccount
    ? emergencyTarget(average, emergency!.emergencyMonths!)
    : null;

  const rules = records.map(toRule);
  const progress = fillByPriority(rules, figures.balances, emergencyTargetCents);
  const required = goalMonthlyRequired(rules, progress, today);
  return affordability(required, null).requiredTotalCents;
}
