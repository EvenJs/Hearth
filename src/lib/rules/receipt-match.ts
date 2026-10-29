// 小票匹配交易和新建交易（business-rules.md R20.4、R20.5、R20.6、R8.1）
// 函数只算出候选和要写的字段，查询和入库由 src/server/ 做
// 纯函数，不 import 数据库和 Next.js
import { suggestKeyword } from './keyword';
import {
  buildManualTransaction,
  guessCategory,
  type ManualAccount,
  type ManualContext,
  type ManualFieldErrors,
  type ManualPrimarySplit,
  type ManualTransaction,
} from './manual';
import { cleanMerchant } from './merchant';
import type { TransactionStatus } from './pending';
import { daysBetween } from './periods';
import type { NormalizedReceipt, ReceiptPaymentMethod } from './receipt';
import type { Card, CategorySource, TransferStatus } from './types';

// ---------- R20.4 匹配交易 ----------

// 数据层传本家庭的交易（可以先按金额和日期范围在 SQL 里粗筛）
export type ReceiptCandidateTx = {
  id: string;
  accountId: string;
  date: string; // YYYY-MM-DD
  amountCents: number;
  cardLast4: string | null;
  merchant: string;
  status: TransactionStatus; // pending、confirmed 都算
  transferStatus: TransferStatus;
  hasReceipt: boolean; // 已经挂了小票（receipt.transaction_id 指向它）
};

// defaultId：只有 1 个候选时默认选中；0 个按 R20.5 新建；≥ 2 个不默认选
export type ReceiptCandidates = { candidates: ReceiptCandidateTx[]; defaultId: string | null };

// 银行入账不早于消费，最多晚 3 天（同 R8.2）
const MAX_DAYS_LATER = 3;

// R20.4：receipt 是通过 checkReceipt 的（日期、总额有值）。cardLast4 是 reader 读到的，只在内存里用
export function findReceiptCandidates(
  receipt: Pick<NormalizedReceipt, 'merchant' | 'date' | 'totalCents'>,
  cardLast4: string | null,
  txs: readonly ReceiptCandidateTx[],
  cards: readonly Card[],
): ReceiptCandidates {
  const { date, totalCents } = receipt;
  if (date === null || totalCents === null)
    throw new Error('小票没有日期或总额，先过 checkReceipt');

  // 卡号：card 表里有这个尾号 → 只在这些卡所在的账户里找；没有就不按卡号过滤
  const cardAccountIds = cardLast4
    ? new Set(cards.filter((c) => c.last4 === cardLast4).map((c) => c.accountId))
    : new Set<string>();
  const filterByCard = cardAccountIds.size > 0;

  const keyword = suggestKeyword(cleanMerchant(receipt.merchant)).toUpperCase();

  const ranked = txs
    .filter((t) => {
      if (t.amountCents !== -totalCents) return false;
      const later = daysBetween(date, t.date); // 交易日期 − 小票日期
      if (later < 0 || later > MAX_DAYS_LATER) return false;
      if (t.transferStatus !== 'none') return false; // 转账不能拆（R15.2），suggested 也不要
      if (t.hasReceipt) return false;
      if (filterByCard) {
        if (!cardAccountIds.has(t.accountId)) return false;
        if (t.cardLast4 !== null && t.cardLast4 !== cardLast4) return false;
      }
      return true;
    })
    .map((t, index) => ({
      t,
      index,
      sameCard: cardLast4 !== null && t.cardLast4 === cardLast4,
      hasKeyword: keyword !== '' && t.merchant.toUpperCase().includes(keyword),
      gap: daysBetween(date, t.date),
    }));

  // 排序：同卡号在前 → 商家含关键词在前 → 日期差小的在前 → 原来的顺序
  ranked.sort(
    (a, b) =>
      Number(b.sameCard) - Number(a.sameCard) ||
      Number(b.hasKeyword) - Number(a.hasKeyword) ||
      a.gap - b.gap ||
      a.index - b.index,
  );

  const candidates = ranked.map((r) => r.t);
  return { candidates, defaultId: candidates.length === 1 ? candidates[0].id : null };
}

// ---------- R20.5 默认账户 ----------

// accountId：默认选中的账户，null = 不预选让用户选
// cardAccountIds：小票卡号所在的（没归档的）账户，多个时让用户在这几个里选
export type ReceiptAccountDefault = { accountId: string | null; cardAccountIds: string[] };

// R20.5 那张表。lastAccountId 是 R17.2 的上次账户（数据层已经按当前用户取好）
export function defaultReceiptAccount(
  method: ReceiptPaymentMethod,
  cardLast4: string | null,
  cards: readonly Card[],
  accounts: readonly ManualAccount[],
  lastAccountId: string | null,
): ReceiptAccountDefault {
  const active = accounts.filter((a) => !a.isArchived);
  const isActive = (id: string | null) => id !== null && active.some((a) => a.id === id);
  const last = isActive(lastAccountId) ? lastAccountId : null;

  if (method === 'cash') {
    // 第一个没归档的现金账户（accounts 的顺序）
    return { accountId: active.find((a) => a.type === 'cash')?.id ?? null, cardAccountIds: [] };
  }

  if (method === 'card' && cardLast4) {
    const cardAccountIds = active
      .filter((a) => cards.some((c) => c.accountId === a.id && c.last4 === cardLast4))
      .map((a) => a.id);
    if (cardAccountIds.length === 1) return { accountId: cardAccountIds[0], cardAccountIds };
    if (cardAccountIds.length > 1) return { accountId: null, cardAccountIds };
  }

  // card 没有尾号或表里没有、unknown → 上次账户
  return { accountId: last, cardAccountIds: [] };
}

// ---------- R20.5 新建交易 ----------

export type ReceiptTransaction = Omit<ManualTransaction, 'source'> & { source: 'receipt' };

export type ReceiptBuildResult =
  | { ok: true; transaction: ReceiptTransaction; split: ManualPrimarySplit }
  | { ok: false; errors: ManualFieldErrors };

// 整数分 → buildManualTransaction 要的正数金额字符串，2345 → "23.45"
function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// R20.5：包 buildManualTransaction（R17.1），改成 source = receipt
// date = 小票日期，amount = −总额，描述 = 店名（R20.2 整理后），card_last4 空（R8.3 确认时再填）
// 主分类：R7 第 2、3 步猜分类（同 R17.2），没命中是未分类；来源按 R17.3；归属人按 R5（没有卡号）
// status 按账户走 R8.1。不跑 R6.1。拆分（R20.3）在这之后做
export function buildReceiptTransaction(
  receipt: Pick<NormalizedReceipt, 'merchant' | 'date' | 'totalCents'>,
  accountId: string,
  ctx: ManualContext,
): ReceiptBuildResult {
  const { date, totalCents } = receipt;
  if (date === null || totalCents === null || totalCents <= 0) {
    throw new Error('小票没有日期或总额不是正数，先过 checkReceipt');
  }

  const guess = guessCategory(receipt.merchant, 'expense', ctx.rules, ctx.categories);
  const result = buildManualTransaction(
    {
      amount: centsToInput(totalCents),
      kind: 'expense',
      description: receipt.merchant,
      accountId,
      date,
      categoryId: guess?.categoryId ?? null,
      categoryGuessed: guess !== null,
      memberId: null,
    },
    ctx,
  );
  if (!result.ok) return result;

  return {
    ok: true,
    transaction: { ...result.transaction, source: 'receipt' },
    split: result.split,
  };
}

// ---------- R20.6 ----------

export type OverwriteCheck = {
  needed: boolean; // 要弹窗确认覆盖
  splitCount: number; // 拆分 N 条
  manualCategory: boolean; // 主拆分手动改过分类
};

// R20.6：有多个拆分，或主拆分 category_source = manual，算"已经改过"
export function needsOverwriteConfirm(
  splits: readonly { isPrimary: boolean; categorySource: CategorySource }[],
): OverwriteCheck {
  const primary = splits.find((s) => s.isPrimary);
  const manualCategory = primary?.categorySource === 'manual';
  return {
    needed: splits.length > 1 || manualCategory,
    splitCount: splits.length,
    manualCategory,
  };
}
