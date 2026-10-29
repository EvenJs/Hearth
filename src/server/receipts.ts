// 小票的数据层（M6.7-6，business-rules.md R20）
// 识别（reader）→ 整理、校验（R20.2）→ 找候选交易（R20.4）、默认账户（R20.5）、可能已经上传过（R20.7）
// 钱怎么算全部由 src/lib/rules/ 的纯函数决定，这里负责读、校验形状、在事务里写回
// 每个查询都带 household_id。图片只在这次请求的内存里，不写磁盘、不打日志
// cardLast4 只在内存里用（R20.4、R20.5），不入库
import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { financialAccount, receipt, transaction } from '@/db/schema';
import { cleanMerchant } from '@/lib/rules/merchant';
import { addDays, todayInMelbourne } from '@/lib/rules/periods';
import {
  checkReceipt,
  normalizeReceipt,
  type NormalizedReceipt,
  type ReceiptCategoryOption,
  type ReceiptCheck,
  type ReceiptFieldErrors,
} from '@/lib/rules/receipt';
import {
  defaultReceiptAccount,
  findReceiptCandidates,
  type ReceiptAccountDefault,
  type ReceiptCandidateTx,
} from '@/lib/rules/receipt-match';
import type { TransactionStatus } from '@/lib/rules/pending';
import { isSelectableCategory } from '@/lib/rules/split-edit';
import type { Card, TransferStatus } from '@/lib/rules/types';
import type { HouseholdContext } from './context';
import { lastManualAccountId, loadManualContext, type QuickAddCategory } from './manual';
import { getReceiptReader, type ReceiptInput, type ReceiptReader } from './receipt-readers';
import type { DbTx } from './transactions';

// ---------- 返回的形状 ----------

// 核对界面的候选：R20.4 的字段 + 账户名
export type ReceiptCandidate = ReceiptCandidateTx & { accountName: string };

export type ReceiptCandidatesResult = {
  candidates: ReceiptCandidate[]; // 已排好序（R20.4）
  defaultId: string | null; // 只有 1 个时默认选中
  possibleDuplicate: boolean; // R20.7：本家庭已有店名、日期、总额都相同的小票，提示不拦
};

// ok：读出来了；none：RECEIPT_READER = none，直接手动填；failed：识别失败，显示"暂时识别不了"
export type ReceiptReadStatus =
  { status: 'ok' } | { status: 'none' } | { status: 'failed'; reason: string };

export type ReceiptDraft = {
  read: ReceiptReadStatus;
  // 存进 receipt.reader：reader 给的（`llm:<模型名>`），没读出来就是 manual（schema）
  reader: string;
  receipt: NormalizedReceipt; // payment.cardLast4 只在内存里，保存时去掉
  errors: ReceiptFieldErrors; // 每个字段的整理错误，标在对应那行
  check: ReceiptCheck; // R20.2 能不能保存
  categories: ReceiptCategoryOption[]; // 商品能选的分类（R16.3 范围内的支出二级）
  // 日期、总额读不出来时为 null，用户填好后再调 getReceiptCandidates
  candidates: ReceiptCandidatesResult | null;
  account: ReceiptAccountDefault; // R20.5 新建时的默认账户
};

export const MANUAL_READER = 'manual';

// R20.4："交易日期 − 小票日期 ∈ [0, 3]"，SQL 先按这个范围粗筛
const MAX_DAYS_LATER = 3;

// ---------- 分类列表 ----------

// R20.1a：本家庭能选的支出分类 = R16.3 范围内 kind = expense 的二级，label 是 `一级 / 二级`
export function receiptCategoryOptions(
  categories: readonly QuickAddCategory[],
): ReceiptCategoryOption[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return categories.flatMap((c) => {
    if (c.parentId === null || c.kind !== 'expense' || !isSelectableCategory(c)) return [];
    const parent = byId.get(c.parentId);
    if (!parent) return [];
    return [{ id: c.id, label: `${parent.nameEn} / ${c.nameEn}` }];
  });
}

// ---------- R20.4 候选、R20.7 可能已经上传过 ----------

const candidatesInputSchema = z.object({
  merchant: z.string().max(100),
  date: z.iso.date().nullable(),
  totalCents: z.number().int().nullable(),
});

export type ReceiptCandidatesInput = z.input<typeof candidatesInputSchema>;

const cardLast4Schema = z
  .string()
  .regex(/^\d{4}$/)
  .nullable();

async function findCandidates(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
  r: { merchant: string; date: string; totalCents: number },
  cardLast4: string | null,
  cards: readonly Card[],
): Promise<ReceiptCandidatesResult> {
  const hh = ctx.householdId;
  // 金额、日期范围在 SQL 里粗筛，其余条件（转账、已挂小票、卡号）交给 findReceiptCandidates
  const rows = await tx
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      accountName: financialAccount.name,
      date: transaction.date,
      amountCents: transaction.amountCents,
      cardLast4: transaction.cardLast4,
      merchant: transaction.merchant,
      status: transaction.status,
      transferStatus: transaction.transferStatus,
      receiptId: receipt.id,
    })
    .from(transaction)
    .innerJoin(
      financialAccount,
      and(eq(financialAccount.id, transaction.accountId), eq(financialAccount.householdId, hh)),
    )
    .leftJoin(receipt, and(eq(receipt.transactionId, transaction.id), eq(receipt.householdId, hh)))
    .where(
      and(
        eq(transaction.householdId, hh),
        eq(transaction.amountCents, -r.totalCents),
        gte(transaction.date, r.date),
        lte(transaction.date, addDays(r.date, MAX_DAYS_LATER)),
      ),
    )
    .orderBy(transaction.date, transaction.id);

  const names = new Map(rows.map((t) => [t.id, t.accountName]));
  const txs: ReceiptCandidateTx[] = rows.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    date: t.date,
    amountCents: t.amountCents,
    cardLast4: t.cardLast4,
    merchant: t.merchant,
    status: t.status as TransactionStatus,
    transferStatus: t.transferStatus as TransferStatus,
    hasReceipt: t.receiptId !== null,
  }));
  const found = findReceiptCandidates(r, cardLast4, txs, cards);

  // R20.7：店名（清洗后）、日期、总额都相同，挂没挂上都算
  const sameDay = await tx
    .select({ merchant: receipt.merchant })
    .from(receipt)
    .where(
      and(
        eq(receipt.householdId, hh),
        eq(receipt.receiptDate, r.date),
        eq(receipt.totalCents, r.totalCents),
      ),
    );
  const merchant = cleanMerchant(r.merchant);
  const possibleDuplicate = sameDay.some((x) => cleanMerchant(x.merchant) === merchant);

  return {
    candidates: found.candidates.map((c) => ({ ...c, accountName: names.get(c.id)! })),
    defaultId: found.defaultId,
    possibleDuplicate,
  };
}

// R20.4：用户在核对界面改了日期、总额、店名后重新找候选。日期或总额还没有 → 没有候选
// cardLast4 是 scanReceipt 返回的，只在内存里，原样传回来
export async function getReceiptCandidates(
  ctx: HouseholdContext,
  input: ReceiptCandidatesInput,
  cardLast4: string | null,
): Promise<ReceiptCandidatesResult> {
  const empty: ReceiptCandidatesResult = {
    candidates: [],
    defaultId: null,
    possibleDuplicate: false,
  };
  const parsed = candidatesInputSchema.safeParse(input);
  const card = cardLast4Schema.safeParse(cardLast4);
  if (!parsed.success || !card.success) return empty;
  const { merchant, date, totalCents } = parsed.data;
  if (date === null || totalCents === null || totalCents <= 0) return empty;

  const m = await loadManualContext(db, ctx, todayInMelbourne());
  return findCandidates(db, ctx, { merchant, date, totalCents }, card.data, m.cards);
}

// ---------- 识别 ----------

function emptyReceipt(): NormalizedReceipt {
  return {
    merchant: '',
    date: null,
    totalCents: null,
    items: [],
    discounts: [],
    payment: { method: 'unknown', cardLast4: null },
  };
}

// R20.1、R20.2、R20.4、R20.5：拍小票进来。reader 是 null（none）或失败时返回空的草稿，让用户手动填
// 测试传假的 reader，不碰网络。不抛错（reader 自己不抛；万一抛了也当作识别失败）
export async function scanReceipt(
  ctx: HouseholdContext,
  input: ReceiptInput,
  reader: ReceiptReader | null = getReceiptReader(),
): Promise<ReceiptDraft> {
  const today = todayInMelbourne();
  const m = await loadManualContext(db, ctx, today);
  const categories = receiptCategoryOptions(m.categories);

  let read: ReceiptReadStatus = { status: 'none' };
  let readerId = MANUAL_READER;
  let receiptValue = emptyReceipt();
  let errors: ReceiptFieldErrors = { items: {}, discounts: {} };

  if (reader !== null) {
    let result: Awaited<ReturnType<ReceiptReader['read']>>;
    try {
      result = await reader.read(
        input,
        categories.map((c) => c.label),
      );
    } catch {
      result = { ok: false, reason: '识别出错' };
    }
    if (result.ok) {
      const normalized = normalizeReceipt(result.raw, categories, today);
      read = { status: 'ok' };
      readerId = result.reader;
      receiptValue = normalized.receipt;
      errors = normalized.errors;
    } else {
      read = { status: 'failed', reason: result.reason };
    }
  }

  const { date, totalCents, merchant, payment } = receiptValue;
  const candidates =
    date !== null && totalCents !== null && totalCents > 0
      ? await findCandidates(db, ctx, { merchant, date, totalCents }, payment.cardLast4, m.cards)
      : null;

  const account = defaultReceiptAccount(
    payment.method,
    payment.cardLast4,
    m.cards,
    m.accounts,
    await lastManualAccountId(ctx, m.accounts),
  );

  return {
    read,
    reader: readerId,
    receipt: receiptValue,
    errors,
    check: checkReceipt(receiptValue),
    categories,
    candidates,
    account,
  };
}
