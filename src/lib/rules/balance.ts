// R23 账户余额、手动校准、用途和关联账户（docs/rules/R23-balance.md）
// 纯函数，不 import 数据库和 Next.js
import type { Bank } from './types';
import { addDays, todayInMelbourne } from './periods';

// ---------- 用途（R23.4） ----------

// 顺序也是账户总览的分组顺序（R23.5）
export const ACCOUNT_PURPOSES = ['everyday', 'bills', 'emergency', 'savings', 'goal'] as const;
export type AccountPurpose = (typeof ACCOUNT_PURPOSES)[number];

export const ACCOUNT_PURPOSE_LABELS: Record<AccountPurpose, string> = {
  everyday: '日常',
  bills: '账单',
  emergency: '应急金',
  savings: '储蓄 / 高息',
  goal: '目标',
};

// ---------- 锚点（R23.1） ----------

// 锚点 = 这个账户 date 这一天结束时的余额
export type BalanceAnchor = {
  source: 'pdf' | 'manual';
  date: string; // YYYY-MM-DD
  amountCents: number;
  createdAt: Date;
};

export type BalanceTx = {
  date: string; // YYYY-MM-DD
  amountCents: number;
  status: 'pending' | 'confirmed';
};

export type AnchorBatch = {
  source: 'csv' | 'pdf';
  dateTo: string;
  closingBalanceCents: number | null;
  createdAt: Date;
};

// R23.1：只有 PDF 批次当锚点，日期 = date_to。CSV 批次（R1B.2、R9 的期末）不用
export function anchorFromBatch(batch: AnchorBatch): BalanceAnchor | null {
  if (batch.source !== 'pdf' || batch.closingBalanceCents === null) return null;
  return {
    source: 'pdf',
    date: batch.dateTo,
    amountCents: batch.closingBalanceCents,
    createdAt: batch.createdAt,
  };
}

// R23.1：新建账户的开户余额锚点日期 = 建账户那天（Melbourne）的前一天
export function openingAnchorDate(accountCreatedAt: Date): string {
  return addDays(todayInMelbourne(accountCreatedAt), -1);
}

const SOURCE_RANK: Record<BalanceAnchor['source'], number> = { pdf: 0, manual: 1 };

// R23.1 的顺序，优先的排前面：日期最晚 → PDF 优先于手动 → created_at 最晚
function compareAnchors(a: BalanceAnchor, b: BalanceAnchor): number {
  return (
    b.date.localeCompare(a.date) ||
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
    b.createdAt.getTime() - a.createdAt.getTime()
  );
}

// R23.1：每个账户只用一个锚点，没有返回 null
export function pickAnchor<T extends BalanceAnchor>(anchors: readonly T[]): T | null {
  return [...anchors].sort(compareAnchors)[0] ?? null;
}

// ---------- 当前余额（R23.2） ----------

export type CurrentBalance = {
  postedCents: number; // 入账余额
  availableCents: number; // 可用余额 = 入账 + pendingCents
  pendingCount: number; // date > 锚点日期的 pending
  pendingCents: number;
  asOf: string; // 截至
};

// R23.2：只算 date > 锚点日期的交易；锚点当天的已经在锚点里。没有锚点 → 没有余额（不从 0 累加）
// transactions 只传这个账户的
export function currentBalance(
  anchor: Pick<BalanceAnchor, 'date' | 'amountCents'> | null,
  transactions: readonly BalanceTx[],
): CurrentBalance | null {
  if (anchor === null) return null;

  let postedCents = anchor.amountCents;
  let pendingCount = 0;
  let pendingCents = 0;
  let asOf = anchor.date;
  for (const t of transactions) {
    if (t.date <= anchor.date) continue;
    if (t.status === 'confirmed') {
      postedCents += t.amountCents;
    } else {
      pendingCount += 1;
      pendingCents += t.amountCents;
    }
    if (t.date > asOf) asOf = t.date;
  }
  return { postedCents, availableCents: postedCents + pendingCents, pendingCount, pendingCents, asOf };
}

// ---------- 手动校准（R23.3） ----------

// R23.3 第 1 步：除 manual 以外、日期 ≤ manual 日期的锚点里按 R23.1 选。同一天的 PDF 也算
// 按引用排除 manual，anchors 里要放同一个对象
export function previousAnchor<T extends BalanceAnchor>(manual: BalanceAnchor, anchors: readonly T[]): T | null {
  return pickAnchor(anchors.filter((a) => a !== manual && a.date <= manual.date));
}

// R23.3：差额 = 填的数 − (P 的金额 + Σ confirmed，P 日期 < date ≤ manual 日期)。不算 pending
// 没有 P → null，不比较。正负含义同 R9
export function calibrationDiff(
  manual: Pick<BalanceAnchor, 'date' | 'amountCents'>,
  previous: Pick<BalanceAnchor, 'date' | 'amountCents'> | null,
  transactions: readonly BalanceTx[],
): number | null {
  if (previous === null) return null;
  const sum = transactions
    .filter((t) => t.status === 'confirmed' && t.date > previous.date && t.date <= manual.date)
    .reduce((s, t) => s + t.amountCents, 0);
  return manual.amountCents - (previous.amountCents + sum);
}

// R23.3 卡片：最近一次手动校准（日期最晚，同一天 created_at 最晚）的差额，不管它是不是当前锚点
// 没有手动锚点或第一次填 → null
export function lastCalibrationDiff(
  anchors: readonly BalanceAnchor[],
  transactions: readonly BalanceTx[],
): number | null {
  const last = pickAnchor(anchors.filter((a) => a.source === 'manual'));
  if (last === null) return null;
  return calibrationDiff(last, previousAnchor(last, anchors), transactions);
}

// ---------- 账户总览（R23.5） ----------

export type OverviewAccount = {
  name: string;
  purpose: AccountPurpose;
  isArchived: boolean;
  balance: CurrentBalance | null; // null = 没有锚点
};

export type PurposeGroup<T> = {
  purpose: AccountPurpose;
  accounts: T[];
  availableCents: number;
};

export type AccountsOverview<T> = {
  groups: PurposeGroup<T>[];
  availableCents: number; // 顶部合计
  postedCents: number; // 入账合计，hasPending 时才显示
  hasPending: boolean;
  missingCount: number; // 还没有余额的账户数
};

// R23.5：不含归档的；按用途顺序分组，空组不显示；组里按名字排；合计只算有锚点的
export function groupByPurpose<T extends OverviewAccount>(accounts: readonly T[]): AccountsOverview<T> {
  const active = accounts
    .filter((a) => !a.isArchived)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const groups: PurposeGroup<T>[] = [];
  for (const purpose of ACCOUNT_PURPOSES) {
    const inGroup = active.filter((a) => a.purpose === purpose);
    if (inGroup.length === 0) continue;
    const availableCents = inGroup.reduce((s, a) => s + (a.balance?.availableCents ?? 0), 0);
    groups.push({ purpose, accounts: inGroup, availableCents });
  }

  let availableCents = 0;
  let postedCents = 0;
  let hasPending = false;
  let missingCount = 0;
  for (const a of active) {
    if (a.balance === null) {
      missingCount += 1;
      continue;
    }
    availableCents += a.balance.availableCents;
    postedCents += a.balance.postedCents;
    if (a.balance.pendingCount > 0) hasPending = true;
  }
  return { groups, availableCents, postedCents, hasPending, missingCount };
}

// ---------- 关联账户（R23.4） ----------

export type LinkAccount = {
  id: string;
  householdId: string;
  bank: Bank;
  isArchived: boolean;
};

// R23.4：按顺序第一条不过就返回错误，通过返回 null
// target = 按 id 查到的账户，查不到传 null。设成"不关联"、关联没改时调用方不调
export function validateLink(
  account: Omit<LinkAccount, 'isArchived'>,
  target: LinkAccount | null,
): string | null {
  if (target !== null && target.id === account.id) return '不能关联自己';
  if (target === null || target.householdId !== account.householdId) return '找不到这个账户';
  if (target.isArchived) return '不能关联已归档的账户';
  if (account.bank === 'cash') return '现金账户不能关联别的账户';
  if (target.bank === 'cash') return '不能关联现金账户';
  return null;
}
