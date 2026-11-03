// R24 每月条件（docs/rules/R24-monthly-condition.md）
// 纯函数，不 import 数据库和 Next.js。判断结果每次实时算，不存
// M10-2：min_deposit、no_withdrawal、linked_min_deposit、linked_card_count。balance_growth、other 在 M10-3 接上
import { formatAud } from './money';
import { endOfMonth, startOfMonth } from './periods';
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

// 生效月份（effective_from、disabled_from）由调用方筛，evaluateCondition 不看
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
  feeInterestCents: number; // 这笔交易上 Bank fees、Income / Interest 拆分的金额合计（符号同交易）
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
const effectiveCents = (t: ConditionTx) => t.amountCents - t.feeInterestCents;
const isWithdrawal = (t: ConditionTx) => effectiveCents(t) < 0;
const isCard = (t: ConditionTx) => isWithdrawal(t) && t.transferStatus === 'none';

export type DepositSum = {
  totalCents: number;
  unknownCount: number; // 对方未知的存入笔数，只有 exclude_linked 算，any 是 0
};

// R24.2、R24.3：transactions 是看的账户当月的交易，这里只筛 confirmed
// exclude_linked：去掉对方账户的 linked_account_id = 看的账户的存入；对方未知按算数
export function countableDeposits(
  transactions: readonly ConditionTx[],
  watched: Pick<ConditionAccount, 'id'>,
  filter: DepositFilter,
  accounts: readonly Pick<ConditionAccount, 'id' | 'linkedAccountId'>[],
): DepositSum {
  const linkedToWatched = new Set(accounts.filter((a) => a.linkedAccountId === watched.id).map((a) => a.id));
  let totalCents = 0;
  let unknownCount = 0;
  for (const t of transactions) {
    const cents = effectiveCents(t);
    if (t.status !== 'confirmed' || cents <= 0) continue;
    if (filter === 'exclude_linked') {
      if (t.counterpartyAccountId === null) unknownCount += 1;
      else if (linkedToWatched.has(t.counterpartyAccountId)) continue;
    }
    totalCents += cents;
  }
  return { totalCents, unknownCount };
}

// ---------- 判断（R24.5） ----------

export type ConditionStatus = 'met' | 'failed' | 'in_progress' | 'unknown';

export type WithdrawalReason = {
  date: string;
  amountCents: number; // 绝对值
  counterpartyName: string | null; // 认不出 → null，显示 merchant
  merchant: string | null;
  count: number; // 本月取款笔数
};

export type ConditionResult = {
  conditionId: string;
  type: ConditionType;
  status: ConditionStatus;
  unknownReason: 'no_linked_account' | null;
  watchedLabel: string | null; // 关联类型显示的"{关联账户名}"，归档的加"（已归档）"
  currentValue: number | null; // 存入合计（分）或刷卡笔数
  target: number | null;
  remaining: number | null; // 还差多少，够了是 0
  unknownDepositCount: number; // R24.3 小字的 N
  withdrawal: WithdrawalReason | null; // no_withdrawal 失败原因
  asOf: string | null; // 看的账户的截至
  monthOver: boolean;
  stale: boolean; // 月份过完、截至早于月底（或没有数据）
};

export type ConditionContext = {
  account: ConditionAccount; // 配条件的账户
  accounts: readonly ConditionAccount[]; // 家庭所有账户：找关联账户、exclude_linked、对方账户名
  month: string; // 这个月里任意一天
  today: string; // Melbourne
  transactions: readonly ConditionTx[]; // 至少包含看的账户这个月的交易，这里按账户和月份筛
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
    status: 'unknown',
    unknownReason: null,
    watchedLabel: null,
    currentValue: null,
    target: null,
    remaining: null,
    unknownDepositCount: 0,
    withdrawal: null,
    asOf: watched?.asOf ?? null,
    monthOver,
    stale: false,
  };

  // R24.5：关联类型没有关联账户 → unknown，排在所有判断前面
  if (watched === null) return { ...base, unknownReason: 'no_linked_account' };

  const label = isLinkedType(condition.type) ? watched.name + (watched.archived ? '（已归档）' : '') : null;
  const watchedId = watched.id;
  const txs = ctx.transactions.filter(
    (t) => t.accountId === watchedId && t.status === 'confirmed' && t.date >= start && t.date <= end,
  );
  const stale = monthOver && (watched.asOf === null || watched.asOf < end);
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
      const sum = countableDeposits(txs, watched, condition.depositFilter, ctx.accounts);
      return { ...reachTarget(sum.totalCents, condition.amountCents), unknownDepositCount: sum.unknownCount };
    }
    case 'linked_card_count':
      return reachTarget(txs.filter(isCard).length, condition.cardCount);
    case 'no_withdrawal': {
      const withdrawals = txs.filter(isWithdrawal).sort(firstByDate);
      const first = withdrawals[0];
      if (!first) return { ...result, status: monthOver ? 'met' : 'in_progress' };
      const counterparty =
        first.counterpartyAccountId === null
          ? undefined
          : ctx.accounts.find((a) => a.id === first.counterpartyAccountId);
      return {
        ...result,
        status: 'failed',
        withdrawal: {
          date: first.date,
          amountCents: -effectiveCents(first),
          counterpartyName: counterparty?.name ?? null,
          merchant: first.merchant,
          count: withdrawals.length,
        },
      };
    }
    case 'balance_growth':
    case 'other':
      throw new Error(`${condition.type} 还没接上（M10-3）`);
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
      return w.count > 1 ? `${text}，本月共 ${w.count} 笔取款` : text;
    }
    case 'balance_growth':
    case 'other':
      throw new Error(`${r.type} 还没接上（M10-3）`);
  }
}

// R24.5：一行条件说明。关联类型前面加"{关联账户名}："；月份过完且截至早于月底时 met、failed 后面加"可能不准"
export function describeCondition(r: ConditionResult): string {
  if (r.unknownReason === 'no_linked_account') return '关联账户没设置';
  let text = mainText(r);
  if (r.watchedLabel !== null) text = `${r.watchedLabel}：${text}`;
  if (r.stale && (r.status === 'met' || r.status === 'failed')) {
    text += r.asOf === null ? '（还没有数据，可能不准）' : `（数据截至 ${mmdd(r.asOf)}，可能不准）`;
  }
  return text;
}

// R24.3：只有 exclude_linked 显示，N 是 0 不显示
export function unknownDepositNote(r: ConditionResult): string | null {
  return r.unknownDepositCount > 0 ? `${r.unknownDepositCount} 笔存入认不出来自哪个账户，按算数处理` : null;
}
