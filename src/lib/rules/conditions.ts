// R24 每月条件（docs/rules/R24-monthly-condition.md）
// 纯函数，不 import 数据库和 Next.js。判断结果每次实时算，不存
import { balanceAt, type BalanceAnchor } from './balance';
import { formatAud } from './money';
import { MAX_DAYS_LATER } from './pending';
import { addDays, endOfMonth, lastTwelveMonths, startOfMonth } from './periods';
import { storedTransferAccountId } from './transfer';
import type { Account, TransferStatus } from './types';

// ---------- 条件（R24.1） ----------

export const CONDITION_TYPES = [
  'min_deposit',
  'no_withdrawal',
  'balance_growth',
  'linked_min_deposit',
  'linked_card_count',
  'other',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const DEPOSIT_FILTERS = ['any', 'exclude_linked'] as const;
export type DepositFilter = (typeof DEPOSIT_FILTERS)[number];

export const CONDITION_OUTCOMES = ['bonus', 'fee_waiver'] as const;
export type ConditionOutcome = (typeof CONDITION_OUTCOMES)[number];

// R24.1 类型的"显示"一列
export const CONDITION_TYPE_LABELS: Record<ConditionType, string> = {
  min_deposit: '当月存入至少 $X',
  no_withdrawal: '当月不取款',
  balance_growth: '月末余额比上月末高',
  linked_min_deposit: '关联账户当月存入至少 $X',
  linked_card_count: '关联账户当月刷卡至少 N 笔',
  other: '其他（文字描述）',
};

// R24.3
export const DEPOSIT_FILTER_LABELS: Record<DepositFilter, string> = {
  any: '任何存入',
  exclude_linked: '去掉关联到这个账户的 saver 转回来的',
};

// 生效月份（ConditionPeriod）由调用方用 isJudgedIn 筛，evaluateCondition 不看
export type MonthlyCondition = {
  id: string;
  accountId: string; // 配条件的账户
  outcome: ConditionOutcome;
} & (
  | { type: 'min_deposit' | 'linked_min_deposit'; amountCents: number; depositFilter: DepositFilter }
  | { type: 'linked_card_count'; cardCount: number }
  | { type: 'no_withdrawal' | 'balance_growth' }
  | { type: 'other'; description: string }
);

// R24.1：存月初日期
export type ConditionPeriod = {
  effectiveFrom: string;
  disabledFrom: string | null; // null = 还在用
};

// R24.1：effective_from ≤ 月份 < disabled_from
export function isJudgedIn(period: ConditionPeriod, month: string): boolean {
  const m = startOfMonth(month);
  return period.effectiveFrom <= m && (period.disabledFrom === null || m < period.disabledFrom);
}

// R24.7：满足了 / 没满足；还没勾 = null
export type ManualCheck = 'met' | 'failed';

export type ConditionAccount = {
  id: string;
  name: string;
  linkedAccountId: string | null; // 现在的关联（R24.1：历史月份也按现在的算）
  archived: boolean;
  asOf: string | null; // R24.6，用 dataAsOf 算
};

export type ConditionTx = {
  id: string;
  accountId: string;
  date: string; // YYYY-MM-DD
  amountCents: number;
  status: 'pending' | 'confirmed';
  transferStatus: TransferStatus;
  counterpartyAccountId: string | null; // resolveCounterparty 的结果
  bankFeeCents: number; // 这笔交易上 Bank fees 拆分的金额合计（符号同交易）
  interestCents: number; // Income / Interest 拆分的金额合计
  merchant: string | null;
  createdAt: Date;
};

// ---------- 数据截至（R24.6） ----------

// R24.6：max(R23.1 当前锚点日期, 最晚一笔 confirmed 交易日期)，不算 pending。都没有 → null
// transactions 只传这个账户的
export function dataAsOf(
  anchorDate: string | null,
  transactions: readonly Pick<ConditionTx, 'date' | 'status'>[],
): string | null {
  let asOf = anchorDate;
  for (const t of transactions) {
    if (t.status === 'confirmed' && (asOf === null || t.date > asOf)) asOf = t.date;
  }
  return asOf;
}

const mmdd = (date: string) => date.slice(5);

// R24.6 显示
export function asOfLabel(asOf: string | null): string {
  return asOf === null ? '还没有数据' : `数据截至 ${mmdd(asOf)}`;
}

// ---------- 对方账户（R24.3） ----------

export type CounterpartyInput = {
  accountId: string;
  transferStatus: TransferStatus;
  pairAccountId: string | null; // transfer_pair_id 那笔交易的账户
  maskedDescription: string;
};

// R24.3：1. 有配对 → 配对那笔的账户；2. auto / confirmed → 从脱敏描述重跑 R6.1；3. 别的 → 未知（null）
export function resolveCounterparty(tx: CounterpartyInput, accounts: readonly Account[]): string | null {
  if (tx.pairAccountId !== null) return tx.pairAccountId;
  if (tx.transferStatus !== 'auto' && tx.transferStatus !== 'confirmed') return null;
  const account = accounts.find((a) => a.id === tx.accountId);
  if (!account) return null;
  return storedTransferAccountId(tx.maskedDescription, account, accounts);
}

// ---------- 存入、取款、刷卡（R24.2） ----------

// R24.2：有效金额 = amount − Bank fees / Interest 拆分
const effectiveCents = (t: ConditionTx) => t.amountCents - t.bankFeeCents - t.interestCents;
const isWithdrawal = (t: ConditionTx) => effectiveCents(t) < 0;
const isCard = (t: ConditionTx) => isWithdrawal(t) && t.transferStatus === 'none';

// R24.3：exclude_linked 去掉对方账户的 linked_account_id = 看的账户的存入；对方未知按算数
function depositFilterOf(
  watched: Pick<ConditionAccount, 'id'>,
  filter: DepositFilter,
  accounts: readonly Pick<ConditionAccount, 'id' | 'linkedAccountId'>[],
): (t: ConditionTx) => boolean {
  const linkedToWatched = new Set(accounts.filter((a) => a.linkedAccountId === watched.id).map((a) => a.id));
  return (t) =>
    effectiveCents(t) > 0 &&
    !(filter === 'exclude_linked' && t.counterpartyAccountId !== null && linkedToWatched.has(t.counterpartyAccountId));
}

export type DepositSum = {
  totalCents: number;
  unknownCount: number; // 对方未知的存入笔数，只有 exclude_linked 算，any 是 0
};

// R24.2、R24.3：transactions 是看的账户当月、已经按 R24.2a 筛过的交易（pending 都算）
export function countableDeposits(
  transactions: readonly ConditionTx[],
  watched: Pick<ConditionAccount, 'id'>,
  filter: DepositFilter,
  accounts: readonly Pick<ConditionAccount, 'id' | 'linkedAccountId'>[],
): DepositSum {
  const counts = depositFilterOf(watched, filter, accounts);
  let totalCents = 0;
  let unknownCount = 0;
  for (const t of transactions) {
    if (!counts(t)) continue;
    if (filter === 'exclude_linked' && t.counterpartyAccountId === null) unknownCount += 1;
    totalCents += effectiveCents(t);
  }
  return { totalCents, unknownCount };
}

// ---------- pending（R24.2a） ----------

export const MONTH_END_PENDING_DAYS = 3;

export type PendingVerdict = 'counted' | 'stale' | 'duplicate';

// R24.2a：tx 是 pending。可能重复（R17.6，数据层传进来）→ duplicate；
// 日期 ≤ 看的账户截至 − MAX_DAYS_LATER → stale（和 R8.4 一样）；没有截至不算过期
export function countablePending(
  tx: Pick<ConditionTx, 'id' | 'date'>,
  asOf: string | null,
  duplicateIds: ReadonlySet<string>,
): PendingVerdict {
  if (duplicateIds.has(tx.id)) return 'duplicate';
  if (asOf !== null && tx.date <= addDays(asOf, -MAX_DAYS_LATER)) return 'stale';
  return 'counted';
}

type PendingCounts = Pick<ConditionResult, 'pendingCount' | 'unmatchedPendingCount' | 'monthEndPendingCount'>;

// R24.2a：measured 是算进这个口径的交易，missed 是没算进去、本来属于这个口径的 pending
function pendingCounts(measured: readonly ConditionTx[], missed: readonly ConditionTx[], end: string): PendingCounts {
  const pending = measured.filter((t) => t.status === 'pending');
  const monthEnd = addDays(end, -(MONTH_END_PENDING_DAYS - 1));
  return {
    pendingCount: pending.length,
    unmatchedPendingCount: missed.length,
    monthEndPendingCount: pending.filter((t) => t.date >= monthEnd).length,
  };
}

// ---------- 判断（R24.5） ----------

export type ConditionStatus = 'met' | 'failed' | 'in_progress' | 'unknown';

export type WithdrawalReason = {
  date: string;
  amountCents: number; // 绝对值
  counterpartyName: string | null; // 认不出 → null，显示 merchant
  merchant: string | null;
  pending: boolean; // R24.5：这笔是 pending → 后面加"（待入账）"
  count: number; // 本月取款笔数
};

export type ConditionResult = {
  conditionId: string;
  type: ConditionType;
  status: ConditionStatus;
  month: string; // 月初
  unknownReason: 'no_linked_account' | 'no_balance' | 'not_checked' | null;
  watchedLabel: string | null; // 关联类型显示的"{关联账户名}"，归档的加"（已归档）"
  currentValue: number | null; // 存入合计（分）、刷卡笔数；balance_growth 是现在 / 月末余额
  target: number | null; // balance_growth 是上月末余额
  remaining: number | null; // 还差多少，够了是 0；balance_growth 不算
  unknownDepositCount: number; // R24.3 小字的 N
  withdrawal: WithdrawalReason | null; // no_withdrawal 失败原因
  // R24.2a，只数这个条件口径（存入 / 取款 / 刷卡）的 pending
  pendingCount: number; // 算进去的
  unmatchedPendingCount: number; // 过期或可能重复，没算进去的
  monthEndPendingCount: number; // 算进去的里日期在这个月最后 MONTH_END_PENDING_DAYS 天的
  asOf: string | null; // 看的账户的截至
  monthOver: boolean;
  stale: boolean; // 月份过完、截至早于月底（或没有数据）
};

export type ConditionContext = {
  account: ConditionAccount; // 配条件的账户
  accounts: readonly ConditionAccount[]; // 家庭所有账户：找关联账户、exclude_linked、对方账户名
  month: string; // 这个月里任意一天
  today: string; // Melbourne
  // 至少包含看的账户这个月的交易，这里按账户和月份筛
  // balance_growth 还要本账户上月末之前最近的锚点以后的交易
  transactions: readonly ConditionTx[];
  anchors: readonly BalanceAnchor[]; // 本账户的锚点（R23.1），balance_growth 用
  manualCheck: ManualCheck | null; // 这个条件这个月的手动勾，other 用
  possibleDuplicatePendingIds: ReadonlySet<string>; // R24.2a #2，数据层按 R17.6 算
};

const isLinkedType = (type: ConditionType) => type === 'linked_min_deposit' || type === 'linked_card_count';

const firstByDate = (a: ConditionTx, b: ConditionTx) =>
  a.date.localeCompare(b.date) || a.createdAt.getTime() - b.createdAt.getTime();

export function evaluateCondition(condition: MonthlyCondition, ctx: ConditionContext): ConditionResult {
  const start = startOfMonth(ctx.month);
  const end = endOfMonth(ctx.month);
  const monthOver = ctx.today > end; // R24.5：今天晚于月底，不管数据导到哪天

  let watched: ConditionAccount | null = ctx.account;
  if (isLinkedType(condition.type)) {
    const linkedId = ctx.account.linkedAccountId;
    watched = linkedId === null ? null : (ctx.accounts.find((a) => a.id === linkedId) ?? null);
  }

  const base: ConditionResult = {
    conditionId: condition.id,
    type: condition.type,
    month: start,
    status: 'unknown',
    unknownReason: null,
    watchedLabel: null,
    currentValue: null,
    target: null,
    remaining: null,
    unknownDepositCount: 0,
    withdrawal: null,
    pendingCount: 0,
    unmatchedPendingCount: 0,
    monthEndPendingCount: 0,
    asOf: watched?.asOf ?? null,
    monthOver,
    stale: false,
  };

  // R24.5：关联类型没有关联账户 → unknown，排在所有判断前面
  if (watched === null) return { ...base, unknownReason: 'no_linked_account' };

  const label = isLinkedType(condition.type) ? watched.name + (watched.archived ? '（已归档）' : '') : null;
  const watchedId = watched.id;
  const asOf = watched.asOf;
  // R24.2：confirmed 全算；R24.2a：pending 过期、可能重复的不算，放进 missed
  const txs: ConditionTx[] = [];
  const missed: ConditionTx[] = [];
  for (const t of ctx.transactions) {
    if (t.accountId !== watchedId || t.date < start || t.date > end) continue;
    const counted =
      t.status === 'confirmed' || countablePending(t, asOf, ctx.possibleDuplicatePendingIds) === 'counted';
    (counted ? txs : missed).push(t);
  }
  // other 没有看的账户（R24.1），不加"可能不准"
  const stale = condition.type !== 'other' && monthOver && (watched.asOf === null || watched.asOf < end);
  const result = { ...base, watchedLabel: label, stale };

  // 够了月中就是 met；没够：月份过完 failed，否则 in_progress
  const reachTarget = (current: number, target: number): ConditionResult => ({
    ...result,
    status: current >= target ? 'met' : monthOver ? 'failed' : 'in_progress',
    currentValue: current,
    target,
    remaining: Math.max(target - current, 0),
  });

  switch (condition.type) {
    case 'min_deposit':
    case 'linked_min_deposit': {
      const counts = depositFilterOf(watched, condition.depositFilter, ctx.accounts);
      const sum = countableDeposits(txs, watched, condition.depositFilter, ctx.accounts);
      return {
        ...reachTarget(sum.totalCents, condition.amountCents),
        unknownDepositCount: sum.unknownCount,
        ...pendingCounts(txs.filter(counts), missed.filter(counts), end),
      };
    }
    case 'linked_card_count': {
      const cards = txs.filter(isCard);
      return { ...reachTarget(cards.length, condition.cardCount), ...pendingCounts(cards, missed.filter(isCard), end) };
    }
    case 'no_withdrawal': {
      const withdrawals = txs.filter(isWithdrawal).sort(firstByDate);
      const pending = pendingCounts(withdrawals, missed.filter(isWithdrawal), end);
      const first = withdrawals[0];
      if (!first) return { ...result, ...pending, status: monthOver ? 'met' : 'in_progress' };
      const counterparty =
        first.counterpartyAccountId === null
          ? undefined
          : ctx.accounts.find((a) => a.id === first.counterpartyAccountId);
      return {
        ...result,
        ...pending,
        status: 'failed',
        withdrawal: {
          date: first.date,
          amountCents: -effectiveCents(first),
          counterpartyName: counterparty?.name ?? null,
          merchant: first.merchant,
          pending: first.status === 'pending',
          count: withdrawals.length,
        },
      };
    }
    case 'balance_growth': {
      // R24.4：上月末没有余额 → unknown。有上月末就一定有现在、本月末
      const own = ctx.transactions.filter((t) => t.accountId === ctx.account.id);
      const previous = balanceAt(ctx.anchors, own, addDays(start, -1));
      const current = balanceAt(ctx.anchors, own, monthOver ? end : ctx.today);
      if (previous === null || current === null) return { ...result, unknownReason: 'no_balance' };
      return {
        ...result,
        status: !monthOver ? 'in_progress' : current > previous ? 'met' : 'failed',
        currentValue: current,
        target: previous,
      };
    }
    case 'other':
      // R24.7：还没勾 → unknown，月份过完也一样
      if (ctx.manualCheck === null) return { ...result, unknownReason: 'not_checked' };
      return { ...result, status: ctx.manualCheck };
  }
}

// ---------- 显示文字（R24.5） ----------

function mainText(r: ConditionResult): string {
  switch (r.type) {
    case 'min_deposit':
    case 'linked_min_deposit': {
      const text = `存入 ${formatAud(r.currentValue!)} / ${formatAud(r.target!)}`;
      return r.status === 'met' ? text : `${text}，还差 ${formatAud(r.remaining!)}`;
    }
    case 'linked_card_count': {
      const text = `刷卡 ${r.currentValue} / ${r.target} 笔`;
      return r.status === 'met' ? text : `${text}，还差 ${r.remaining} 笔`;
    }
    case 'no_withdrawal': {
      if (r.status === 'in_progress') return '到目前没有取款';
      const w = r.withdrawal;
      if (w === null) return '没有取款';
      const amount = formatAud(w.amountCents);
      const text =
        w.counterpartyName !== null
          ? `${mmdd(w.date)} 转出 ${amount} 到 ${w.counterpartyName}`
          : `${mmdd(w.date)} 取出 ${amount}${w.merchant ? `（${w.merchant}）` : ''}`;
      const reason = w.pending ? `${text}（待入账）` : text;
      return w.count > 1 ? `${reason}，本月共 ${w.count} 笔取款` : reason;
    }
    case 'balance_growth': {
      const diff = r.currentValue! - r.target!;
      const prefix = `${r.status === 'in_progress' ? '现在' : '月末'} ${formatAud(r.currentValue!)}`;
      if (diff === 0) return `${prefix}，和上月末一样`;
      return `${prefix}，比上月末${diff > 0 ? '多' : '少'} ${formatAud(Math.abs(diff))}`;
    }
    case 'other':
      return r.status === 'met' ? '满足了' : '没满足';
  }
}

const UNKNOWN_TEXT: Record<NonNullable<ConditionResult['unknownReason']>, string> = {
  no_linked_account: '关联账户没设置',
  no_balance: '没有余额，判断不了',
  not_checked: '还没勾',
};

// R24.5：一行条件说明。关联类型前面加"{关联账户名}："；有算进去的 pending 加"（含 N 笔待入账）"
// （no_withdrawal 只在原因里标）；月份过完且截至早于月底时 met、failed 后面再加"可能不准"
export function describeCondition(r: ConditionResult): string {
  if (r.unknownReason !== null) return UNKNOWN_TEXT[r.unknownReason];
  let text = mainText(r);
  if (r.watchedLabel !== null) text = `${r.watchedLabel}：${text}`;
  if (r.type !== 'no_withdrawal' && r.pendingCount > 0) text += `（含 ${r.pendingCount} 笔待入账）`;
  if (r.stale && (r.status === 'met' || r.status === 'failed')) {
    text += r.asOf === null ? '（还没有数据，可能不准）' : `（数据截至 ${mmdd(r.asOf)}，可能不准）`;
  }
  return text;
}

// R24.3：只有 exclude_linked 显示，N 是 0 不显示
export function unknownDepositNote(r: ConditionResult): string | null {
  return r.unknownDepositCount > 0 ? `${r.unknownDepositCount} 笔存入认不出来自哪个账户，按算数处理` : null;
}

// R24.5 pending 的说明，N 是 0 不显示
export function unmatchedPendingNote(r: ConditionResult): string | null {
  return r.unmatchedPendingCount > 0 ? `${r.unmatchedPendingCount} 笔待入账可能没配上，没算进去，去流水看看` : null;
}

export function monthEndPendingNote(r: ConditionResult): string | null {
  return r.monthEndPendingCount > 0
    ? `${r.monthEndPendingCount} 笔待入账在月底 ${MONTH_END_PENDING_DAYS} 天内，银行可能算到下个月`
    : null;
}

// ---------- 合并（R24.5） ----------

// R24.5：有 failed → failed；全部 met → met；有 in_progress → in_progress；其他 → unknown。空 → null
function combineStatuses(statuses: readonly ConditionStatus[]): ConditionStatus | null {
  if (statuses.length === 0) return null;
  if (statuses.includes('failed')) return 'failed';
  if (statuses.every((s) => s === 'met')) return 'met';
  if (statuses.includes('in_progress')) return 'in_progress';
  return 'unknown';
}

export type AccountMonthSummary = {
  byOutcome: Partial<Record<ConditionOutcome, ConditionStatus>>; // 没有这个结果的条件就没有这个 key
  overall: ConditionStatus | null; // 历史小格（R24.10），不分结果。null = 没有条件
};

// R24.5：conditions 是同一个账户这个月在判断的条件（isJudgedIn），results 是它们的结果
export function summarizeAccountMonth(
  conditions: readonly Pick<MonthlyCondition, 'id' | 'outcome'>[],
  results: readonly ConditionResult[],
): AccountMonthSummary {
  const byOutcome: AccountMonthSummary['byOutcome'] = {};
  for (const outcome of CONDITION_OUTCOMES) {
    const ids = new Set(conditions.filter((c) => c.outcome === outcome).map((c) => c.id));
    const status = combineStatuses(results.filter((r) => ids.has(r.conditionId)).map((r) => r.status));
    if (status !== null) byOutcome[outcome] = status;
  }
  return { byOutcome, overall: combineStatuses(results.map((r) => r.status)) };
}

export const OUTCOME_LABELS: Record<ConditionOutcome, string> = { bonus: 'bonus', fee_waiver: '免月费' };

const OUTCOME_STATUS_LABELS: Record<ConditionStatus, string> = {
  met: '拿到',
  failed: '没拿到',
  in_progress: '进行中',
  unknown: '判断不了',
};

// R24.10 点开历史："bonus：拿到"、"免月费：没拿到"
export function outcomeSummaryText(outcome: ConditionOutcome, status: ConditionStatus): string {
  return `${OUTCOME_LABELS[outcome]}：${OUTCOME_STATUS_LABELS[status]}`;
}

// R24.10 历史小格
export const MONTH_CELL_LABELS: Record<ConditionStatus, string> = {
  failed: '失败',
  met: '满足',
  in_progress: '进行中',
  unknown: '判断不了',
};

// ---------- 月费校验（R24.8） ----------

// R24.8：fee_waiver 合并是 met，这个月 confirmed 交易上 Bank fees 净额 < 0 → 返回净额的绝对值，否则 null
// transactions 只传这个账户的
export function feeMismatch(
  summary: AccountMonthSummary,
  transactions: readonly ConditionTx[],
  month: string,
): number | null {
  if (summary.byOutcome.fee_waiver !== 'met') return null;
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  const net = transactions
    .filter((t) => t.status === 'confirmed' && t.date >= start && t.date <= end)
    .reduce((s, t) => s + t.bankFeeCents, 0);
  return net < 0 ? -net : null;
}

export function feeMismatchText(cents: number): string {
  return `这个月判断满足了，但还是收了 ${formatAud(cents)} 月费，条件配置可能不对`;
}

// ---------- 首页提示（R24.9） ----------

export const CONDITION_REMINDER_DAYS = 5;

export type ReminderItem = {
  accountName: string; // 配条件的账户
  result: ConditionResult;
};

export type HomeReminder = {
  count: number; // 条件个数，不是账户个数
  asOf: string | null; // 这些条件里最早的截至，有没有数据的就是 null
  text: string;
};

// R24.9：有"还差"的 in_progress。balance_growth 只算现在 ≤ 上月末
function needsReminder(r: ConditionResult): boolean {
  if (r.status !== 'in_progress') return false;
  switch (r.type) {
    case 'min_deposit':
    case 'linked_min_deposit':
    case 'linked_card_count':
      return true;
    case 'balance_growth':
      return r.currentValue! <= r.target!;
    case 'no_withdrawal':
    case 'other':
      return false;
  }
}

function reminderLine({ accountName, result: r }: ReminderItem): string {
  switch (r.type) {
    case 'min_deposit':
      return `${accountName} 本月存入还差 ${formatAud(r.remaining!)}`;
    case 'linked_min_deposit':
      return `${accountName} 的关联账户 ${r.watchedLabel} 本月存入还差 ${formatAud(r.remaining!)}`;
    case 'linked_card_count':
      return `${accountName} 的关联账户 ${r.watchedLabel} 本月刷卡还差 ${r.remaining} 笔`;
    case 'balance_growth': {
      const short = r.target! - r.currentValue!;
      return short === 0
        ? `${accountName} 现在和上月末一样，月底要比上月末高`
        : `${accountName} 现在比上月末少 ${formatAud(short)}`;
    }
    case 'no_withdrawal':
    case 'other':
      throw new Error(`${r.type} 不提示`);
  }
}

// R24.9：今天在本月最后 CONDITION_REMINDER_DAYS 天里（含最后一天）
export function inReminderWindow(today: string): boolean {
  return today >= addDays(endOfMonth(today), -(CONDITION_REMINDER_DAYS - 1));
}

// R24.9：本月最后 CONDITION_REMINDER_DAYS 天里，有要提示的条件 → 一行；否则 null
// items 是本家庭没归档账户、本月在判断的条件的结果；别的月份的结果不算
export function homeReminder(items: readonly ReminderItem[], today: string): HomeReminder | null {
  if (!inReminderWindow(today)) return null;
  const month = startOfMonth(today);
  const due = items.filter((i) => i.result.month === month && needsReminder(i.result));
  const first = due[0];
  if (!first) return null;

  // 没有截至日期的排最前
  const asOf = due
    .map((i) => i.result.asOf)
    .reduce((min, d) => (min === null || d === null ? null : d < min ? d : min));
  const suffix = `（${asOfLabel(asOf)}）`;
  const text = due.length === 1 ? reminderLine(first) : `${due.length} 个账户条件本月还没满足`;
  return { count: due.length, asOf, text: text + suffix };
}

// ---------- 历史（R24.10） ----------

// R24.10：最近 12 个月（含本月）里，从这个账户在判断过的条件最早的 effective_from 开始，返回月初日期
// 中间没有条件在判断的月份照样返回（空格子"没有条件"）。effective_from = disabled_from 的一个月也不判断，不算
export function monthsForHistory(periods: readonly ConditionPeriod[], today: string): string[] {
  const used = periods.filter((p) => p.disabledFrom === null || p.effectiveFrom < p.disabledFrom);
  if (used.length === 0) return [];
  const earliest = used.map((p) => p.effectiveFrom).reduce((min, d) => (d < min ? d : min));
  return lastTwelveMonths(today)
    .map((r) => r.start)
    .filter((m) => m >= earliest);
}
