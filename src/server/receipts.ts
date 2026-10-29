// 小票的数据层（M6.7-6，business-rules.md R20）
// 识别（reader）→ 整理、校验（R20.2）→ 找候选交易（R20.4）、默认账户（R20.5）、可能已经上传过（R20.7）
// 钱怎么算全部由 src/lib/rules/ 的纯函数决定，这里负责读、校验形状、在事务里写回
// 每个查询都带 household_id。图片只在这次请求的内存里，不写磁盘、不打日志
// cardLast4 只在内存里用（R20.4、R20.5），不入库
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { financialAccount, member, receipt, transaction } from '@/db/schema';
import { cleanMerchant } from '@/lib/rules/merchant';
import { addDays, todayInMelbourne } from '@/lib/rules/periods';
import {
  checkReceipt,
  normalizeReceipt,
  rawReceiptSchema,
  type NormalizedReceipt,
  type ReceiptCheckIssue,
  type ReceiptCategoryOption,
  type ReceiptCheck,
  type ReceiptFieldErrors,
} from '@/lib/rules/receipt';
import {
  buildReceiptTransaction,
  defaultReceiptAccount,
  findReceiptCandidates,
  needsOverwriteConfirm,
  type OverwriteCheck,
  type ReceiptAccountDefault,
  type ReceiptCandidateTx,
  type ReceiptTransaction,
} from '@/lib/rules/receipt-match';
import type { ManualFieldErrors } from '@/lib/rules/manual';
import type { TransactionStatus } from '@/lib/rules/pending';
import { defaultItemCategories, planReceiptSplits } from '@/lib/rules/receipt-split';
import type { SplitRow } from '@/lib/rules/split';
import { isSelectableCategory } from '@/lib/rules/split-edit';
import type { Card, TransferStatus } from '@/lib/rules/types';
import type { HouseholdContext } from './context';
import { lastManualAccountId, loadManualContext, type QuickAddCategory } from './manual';
import { getReceiptReader, type ReceiptInput, type ReceiptReader } from './receipt-readers';
import { lockTransaction, writeSplits, type LoadedTx } from './splits';
import { loadEditContext, type DbTx } from './transactions';

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
  // R20.5 新建时能选的账户（没归档的），按名字排
  accounts: { id: string; name: string; bank: string; type: string }[];
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
    accounts: m.accounts
      .filter((a) => !a.isArchived)
      .map((a) => ({ id: a.id, name: a.name, bank: a.bank, type: a.type })),
  };
}

// ---------- 保存、挂上 ----------

// 挂到哪：已有交易（R20.4 选中的，或从交易详情上传），或在这个账户新建一笔（R20.5）
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transaction'), transactionId: z.uuid() }),
  z.object({ kind: z.literal('new'), accountId: z.uuid() }),
]);

export type ReceiptTarget = z.input<typeof targetSchema>;

// receipt.reader：`llm:<模型名>`、`text`、`manual`（schema）
const readerSchema = z.string().regex(/^(manual|text|llm:[\w./:@-]{1,100})$/);

// 核对后的小票用和 reader 原始结果一样的字符串格式（R20.1），服务器重新跑 normalizeReceipt、checkReceipt
// （R20.2：手动填的商品走同样的整理和校验），不信客户端算的结果
const saveSchema = z.object({
  reader: readerSchema,
  receipt: rawReceiptSchema.refine((r) => r.items.length <= 200 && r.discounts.length <= 50, {
    message: '商品太多',
  }),
  target: targetSchema,
  confirmOverwrite: z.boolean().default(false),
});

export type SaveReceiptInput = z.input<typeof saveSchema>;

export type ReceiptWriteFailure =
  | {
      ok: false;
      code: 'invalid' | 'not_found' | 'transfer' | 'has_receipt' | 'attached';
      message: string;
    }
  // R20.2：整理或校验没过，标在对应那行
  | {
      ok: false;
      code: 'check_failed';
      message: string;
      errors: ReceiptFieldErrors;
      issues: ReceiptCheckIssue[];
    }
  // R20.5：新建交易的字段（账户）不对
  | { ok: false; code: 'account'; message: string; errors: ManualFieldErrors }
  // R20.6：已经改过，要用户确认覆盖。什么都没写
  | {
      ok: false;
      code: 'needs_confirm';
      message: string;
      splitCount: number;
      manualCategory: boolean;
    }
  // R20.3 第 4、5 步：差额是负数、某组合计不是正数、挂在收入上
  | { ok: false; code: 'split_failed'; message: string };

export type SaveReceiptResult =
  { ok: true; receiptId: string; transactionId: string } | ReceiptWriteFailure;
export type AttachReceiptResult = { ok: true; transactionId: string } | ReceiptWriteFailure;
export type DeleteReceiptResult = { ok: true } | { ok: false; code: 'not_found'; message: string };

const INVALID = { ok: false, code: 'invalid', message: '参数不合法' } as const;
const TX_NOT_FOUND = { ok: false, code: 'not_found', message: '找不到这笔交易' } as const;
const RECEIPT_NOT_FOUND = { ok: false, code: 'not_found', message: '找不到这张小票' } as const;

// R20.2：校验没过 → check_failed
function checkFailure(
  receipt: NormalizedReceipt,
  errors: ReceiptFieldErrors,
): Extract<ReceiptWriteFailure, { code: 'check_failed' }> | null {
  const check = checkReceipt(receipt);
  if (check.ok) return null;
  return {
    ok: false,
    code: 'check_failed',
    message: check.issues.map((i) => i.message).join('；'),
    errors,
    issues: check.issues,
  };
}

// 计划阶段的失败（R20.6 的确认在写库前才判断，不在这里）
type PlanFailure = Exclude<ReceiptWriteFailure, { code: 'needs_confirm' }>;

// 挂到交易上之前的计划：所有检查都在这里做完，不写库。保存和预览共用，预览的结果和最后存的一样
type AttachPlan =
  | {
      ok: true;
      kind: 'new';
      transaction: ReceiptTransaction;
      draft: LoadedTx; // id 是空字符串，写库时换成新交易的 id
      rows: SplitRow[]; // 主拆分在第一个
    }
  | {
      ok: true;
      kind: 'existing';
      loaded: LoadedTx;
      rows: SplitRow[];
      overwrite: OverwriteCheck; // R20.6
    };

async function planAttach(
  tx: DbTx,
  ctx: HouseholdContext,
  r: NormalizedReceipt,
  target: z.output<typeof targetSchema>,
  today: string,
): Promise<AttachPlan | PlanFailure> {
  const editCtx = await loadEditContext(tx, ctx);

  if (target.kind === 'new') {
    // R20.5：账户不是本家庭的、归档了 → buildManualTransaction 按字段报错
    const m = await loadManualContext(tx, ctx, today);
    const built = buildReceiptTransaction(r, target.accountId, m);
    if (!built.ok) {
      return {
        ok: false,
        code: 'account',
        message: Object.values(built.errors).join('；'),
        errors: built.errors,
      };
    }
    const primary: SplitRow = { id: null, ...built.split, note: null };
    const draft: LoadedTx = {
      id: '',
      accountId: built.transaction.accountId,
      cardLast4: null,
      amountCents: built.transaction.amountCents,
      transferStatus: 'none',
      splits: [],
    };
    const items = defaultItemCategories(r.items, primary.categoryId);
    const plan = planReceiptSplits(r, items, { ...draft, splits: [primary] }, editCtx);
    if (!plan.ok) return { ok: false, code: 'split_failed', message: plan.message };
    return {
      ok: true,
      kind: 'new',
      transaction: built.transaction,
      draft,
      rows: [plan.primary, ...plan.created],
    };
  }

  // 已有交易：锁住交易和拆分
  const t = await lockTransaction(tx, ctx, target.transactionId);
  if (!t) return TX_NOT_FOUND;
  // R20.4、R15.2：转账不能拆，suggested 的也不要
  if (t.transferStatus !== 'none') {
    return { ok: false, code: 'transfer', message: '内部转账（或建议的转账）不能挂小票' };
  }
  // R20.7：一笔交易只能挂一张小票
  const [existing] = await tx
    .select({ id: receipt.id })
    .from(receipt)
    .where(and(eq(receipt.transactionId, t.id), eq(receipt.householdId, ctx.householdId)));
  if (existing) return { ok: false, code: 'has_receipt', message: '这笔交易已经挂了小票' };

  const primary = t.splits.find((x) => x.isPrimary);
  if (!primary) throw new Error(`交易 ${t.id} 没有主拆分`);
  const items = defaultItemCategories(r.items, primary.categoryId);
  const plan = planReceiptSplits(r, items, t, editCtx);
  if (!plan.ok) return { ok: false, code: 'split_failed', message: plan.message };
  return {
    ok: true,
    kind: 'existing',
    loaded: t,
    rows: [plan.primary, ...plan.created],
    overwrite: needsOverwriteConfirm(t.splits),
  };
}

function overwriteMessage(o: OverwriteCheck): string {
  const parts = [
    o.splitCount > 1 ? `拆分 ${o.splitCount} 条` : null,
    o.manualCategory ? '手动改过分类' : null,
  ].filter(Boolean);
  return `这笔已经手动改过（${parts.join(' / ')}），用小票的结果覆盖吗？原来的拆分会删掉，主拆分的备注保留。`;
}

// 一个事务里把（已经通过 checkReceipt 的）小票挂到交易上，写好拆分。返回交易 id
// 所有检查都在写库之前做完，失败时什么都没写
async function attachInTx(
  tx: DbTx,
  ctx: HouseholdContext,
  r: NormalizedReceipt,
  target: z.output<typeof targetSchema>,
  confirmOverwrite: boolean,
  today: string,
): Promise<{ ok: true; transactionId: string } | ReceiptWriteFailure> {
  const plan = await planAttach(tx, ctx, r, target, today);
  if (!plan.ok) return plan;

  if (plan.kind === 'new') {
    const [row] = await tx
      .insert(transaction)
      .values({ ...plan.transaction, householdId: ctx.householdId, createdBy: ctx.userId })
      .returning({ id: transaction.id });
    await writeSplits(tx, ctx, { ...plan.draft, id: row.id }, plan.rows);
    return { ok: true, transactionId: row.id };
  }

  // R20.6：已经改过，没确认覆盖就不写
  if (plan.overwrite.needed && !confirmOverwrite) {
    return {
      ok: false,
      code: 'needs_confirm',
      message: overwriteMessage(plan.overwrite),
      splitCount: plan.overwrite.splitCount,
      manualCategory: plan.overwrite.manualCategory,
    };
  }
  // 原来的非主拆分不在新列表里，writeSplits 会删掉
  await writeSplits(tx, ctx, plan.loaded, plan.rows);
  return { ok: true, transactionId: plan.loaded.id };
}

// parsed_json（schema）：用户核对后的版本。不含卡号（cardLast4 在这里去掉）、人名
// items[].category 存分类 id，null = 跟主分类（R20.3 第 1 步），重新挂到别的交易时按那笔的主分类走
function toParsedJson(r: NormalizedReceipt) {
  return {
    items: r.items.map((i) => ({
      name: i.name,
      amountCents: i.amountCents,
      category: i.categoryId,
    })),
    discounts: r.discounts.map((d) => ({ label: d.label, amountCents: d.amountCents })),
    payment: r.payment.method,
  };
}

const parsedJsonSchema = z.object({
  items: z.array(
    z.object({ name: z.string(), amountCents: z.number().int(), category: z.string().nullable() }),
  ),
  discounts: z.array(z.object({ label: z.string(), amountCents: z.number().int() })),
  payment: z.enum(['card', 'cash', 'unknown']),
});

// R20.3 到 R20.7：一个事务。服务器重新整理、校验、拆分；交易已经挂了小票、改过但没确认覆盖、转账都报错不写
export async function saveReceipt(
  ctx: HouseholdContext,
  input: SaveReceiptInput,
): Promise<SaveReceiptResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const { reader, target, confirmOverwrite } = parsed.data;
  const today = todayInMelbourne();

  return db.transaction(async (tx) => {
    const m = await loadManualContext(tx, ctx, today);
    const { receipt: r, errors } = normalizeReceipt(
      parsed.data.receipt,
      receiptCategoryOptions(m.categories),
      today,
    );
    const failed = checkFailure(r, errors);
    if (failed) return failed;

    const attached = await attachInTx(tx, ctx, r, target, confirmOverwrite, today);
    if (!attached.ok) return attached;

    const [row] = await tx
      .insert(receipt)
      .values({
        householdId: ctx.householdId,
        transactionId: attached.transactionId,
        merchant: r.merchant,
        receiptDate: r.date!,
        totalCents: r.totalCents!,
        parsedJson: toParsedJson(r),
        reader,
        createdBy: ctx.userId,
      })
      .returning({ id: receipt.id });
    return { ok: true, receiptId: row.id, transactionId: attached.transactionId };
  });
}

// ---------- 预览 ----------

const previewSchema = z.object({
  receipt: saveSchema.shape.receipt,
  target: targetSchema,
});

export type PreviewReceiptInput = z.input<typeof previewSchema>;

export type ReceiptPreviewRow = {
  isPrimary: boolean;
  amountCents: number; // 和交易同符号（支出是负数）
  categoryId: string;
  categoryLabel: string; // `一级 / 二级`，一级和系统分类只有一级的名字
  categorySource: SplitRow['categorySource'];
  memberName: string;
  memberSource: SplitRow['memberSource'];
};

export type ReceiptPreview =
  | {
      ok: true;
      rows: ReceiptPreviewRow[]; // 主拆分在第一个
      // 挂到已有交易时那笔交易（从详情页进来时显示它和差额）；新建时为 null
      transaction: {
        date: string;
        amountCents: number;
        merchant: string;
        accountName: string;
      } | null;
      extraCents: number; // R20.3 第 4 步：交易金额的绝对值 − 小票总额，> 0 时多一组未分类
      overwrite: OverwriteCheck | null; // R20.6，新建时为 null
    }
  | PlanFailure;

// 核对界面的"保存后的拆分"：和 saveReceipt 走同一个计划（planAttach），所以和最后存的一样。不写库
export async function previewReceipt(
  ctx: HouseholdContext,
  input: PreviewReceiptInput,
): Promise<ReceiptPreview> {
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const today = todayInMelbourne();

  return db.transaction(async (tx) => {
    const m = await loadManualContext(tx, ctx, today);
    const { receipt: r, errors } = normalizeReceipt(
      parsed.data.receipt,
      receiptCategoryOptions(m.categories),
      today,
    );
    const failed = checkFailure(r, errors);
    if (failed) return failed;

    const plan = await planAttach(tx, ctx, r, parsed.data.target, today);
    if (!plan.ok) return plan;

    const byId = new Map(m.categories.map((c) => [c.id, c]));
    const label = (id: string) => {
      const c = byId.get(id);
      if (!c) return '?';
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      return parent ? `${parent.nameEn} / ${c.nameEn}` : c.nameEn;
    };
    // 归档的归属人也要能显示名字，所以不用 m.members
    const members = new Map(
      (
        await tx
          .select({ id: member.id, name: member.name })
          .from(member)
          .where(eq(member.householdId, ctx.householdId))
      ).map((x) => [x.id, x.name]),
    );
    const rows = plan.rows.map((x): ReceiptPreviewRow => ({
      isPrimary: x.isPrimary,
      amountCents: x.amountCents,
      categoryId: x.categoryId,
      categoryLabel: label(x.categoryId),
      categorySource: x.categorySource,
      memberName: members.get(x.memberId) ?? '?',
      memberSource: x.memberSource,
    }));

    if (plan.kind === 'new') {
      return { ok: true, rows, transaction: null, extraCents: 0, overwrite: null };
    }
    const [info] = await tx
      .select({
        date: transaction.date,
        amountCents: transaction.amountCents,
        merchant: transaction.merchant,
        accountName: financialAccount.name,
      })
      .from(transaction)
      .innerJoin(financialAccount, eq(financialAccount.id, transaction.accountId))
      .where(and(eq(transaction.id, plan.loaded.id), eq(transaction.householdId, ctx.householdId)));
    return {
      ok: true,
      rows,
      transaction: info,
      extraCents: Math.abs(info.amountCents) - r.totalCents!,
      overwrite: plan.overwrite,
    };
  });
}

// R20.7：给没挂上的小票重新挂（R20.4 选的交易，或 R20.5 新建）。用存着的核对结果，规则和 saveReceipt 一样
// 存的分类现在不能选了（归档）→ 当作 null（R20.2）。存的里面没有卡号，新建时账户由用户选
export async function attachReceipt(
  ctx: HouseholdContext,
  receiptId: string,
  target: ReceiptTarget,
  confirmOverwrite = false,
): Promise<AttachReceiptResult> {
  if (!z.uuid().safeParse(receiptId).success) return INVALID;
  const t = targetSchema.safeParse(target);
  if (!t.success) return INVALID;
  const today = todayInMelbourne();

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(receipt)
      .where(and(eq(receipt.id, receiptId), eq(receipt.householdId, ctx.householdId)))
      .for('update');
    if (!row) return RECEIPT_NOT_FOUND;
    if (row.transactionId !== null) {
      return { ok: false, code: 'attached', message: '这张小票已经挂在一笔交易上了' };
    }

    const stored = parsedJsonSchema.parse(row.parsedJson);
    const m = await loadManualContext(tx, ctx, today);
    const selectable = new Set(receiptCategoryOptions(m.categories).map((c) => c.id));
    const r: NormalizedReceipt = {
      merchant: row.merchant,
      date: row.receiptDate,
      totalCents: row.totalCents,
      items: stored.items.map((i) => ({
        name: i.name,
        amountCents: i.amountCents,
        categoryId: i.category !== null && selectable.has(i.category) ? i.category : null,
      })),
      discounts: stored.discounts,
      payment: { method: stored.payment, cardLast4: null },
    };
    const failed = checkFailure(r, { items: {}, discounts: {} });
    if (failed) return failed;

    const attached = await attachInTx(tx, ctx, r, t.data, confirmOverwrite, today);
    if (!attached.ok) return attached;

    await tx
      .update(receipt)
      .set({ transactionId: attached.transactionId })
      .where(and(eq(receipt.id, receiptId), eq(receipt.householdId, ctx.householdId)));
    return { ok: true, transactionId: attached.transactionId };
  });
}

// R20.7 删除小票：只删 receipt 那行，拆分不动
export async function deleteReceipt(
  ctx: HouseholdContext,
  receiptId: string,
): Promise<DeleteReceiptResult> {
  if (!z.uuid().safeParse(receiptId).success) return RECEIPT_NOT_FOUND;
  const deleted = await db
    .delete(receipt)
    .where(and(eq(receipt.id, receiptId), eq(receipt.householdId, ctx.householdId)))
    .returning({ id: receipt.id });
  return deleted.length > 0 ? { ok: true } : RECEIPT_NOT_FOUND;
}

export type UnattachedReceipt = {
  id: string;
  merchant: string;
  receiptDate: string;
  totalCents: number;
  createdAt: Date;
};

// R20.7：F8 顶部"N 张小票没挂上交易"，点开列出来。小票日期新的在前
export async function listUnattachedReceipts(ctx: HouseholdContext): Promise<UnattachedReceipt[]> {
  return db
    .select({
      id: receipt.id,
      merchant: receipt.merchant,
      receiptDate: receipt.receiptDate,
      totalCents: receipt.totalCents,
      createdAt: receipt.createdAt,
    })
    .from(receipt)
    .where(and(eq(receipt.householdId, ctx.householdId), isNull(receipt.transactionId)))
    .orderBy(desc(receipt.receiptDate), desc(receipt.createdAt), desc(receipt.id));
}
