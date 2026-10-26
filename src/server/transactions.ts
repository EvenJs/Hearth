// F8 流水查询（M4-2）：列表、笔数和合计、详情
// F8 修改（M4-3）：按拆分改分类、归属人，批量修改（R16.1、R16.2、R16.3、R16.4、R5.1）
// F8 建议转账（M4-5）：确认、拒绝，两边一起改（R6.3）
// 筛选条件的含义见 src/lib/transactions/filters.ts；这里只负责拼查询，每个查询都带 household_id
// 交易本身的条件（时间、账户、状态、商家、金额范围、建议转账）放在 transaction 上
// 拆分上的条件（分类、归属人、类型、是否税前、未分类）用 EXISTS：只要有一个拆分命中就列出（R16.5）
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '@/db';
import {
  card,
  category,
  financialAccount,
  importBatch,
  member,
  transaction,
  transactionSplit,
} from '@/db/schema';
import { periodRange } from '@/lib/rules/periods';
import {
  changeCategory,
  changeMember,
  isSelectableCategory,
  type EditCategory,
  type EditContext,
  type EditSplit,
  type EditTarget,
  type TransactionType,
} from '@/lib/rules/split-edit';
import { resolveSuggestion, type SuggestionTx } from '@/lib/rules/transfer';
import type {
  Account,
  Card,
  CategoryKind,
  CategorySource,
  MemberSource,
  SystemCategoryKey,
  TransferStatus,
} from '@/lib/rules/types';
import {
  hasSplitFilter,
  type TransactionFilters,
  type TransactionStatus,
} from '@/lib/transactions/filters';
import type { HouseholdContext } from './context';
import { getPossibleDuplicates } from './duplicates';
import { isActiveMember } from './members';

export const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// ---------- 返回的形状 ----------

export type CategoryRef = {
  id: string;
  nameEn: string;
  nameZh: string | null;
  kind: CategoryKind;
  systemKey: SystemCategoryKey | null;
  parent: { id: string; nameEn: string; nameZh: string | null } | null; // 二级时是它的一级
};

export type SplitView = {
  id: string;
  isPrimary: boolean;
  amountCents: number;
  category: CategoryRef;
  categorySource: CategorySource;
  member: { id: string; name: string };
  memberSource: MemberSource;
  isPreTax: boolean;
  note: string | null;
};

export type TransactionListItem = {
  id: string;
  date: string;
  amountCents: number;
  merchant: string;
  rawDescription: string; // 脱敏后
  cardLast4: string | null;
  status: TransactionStatus;
  source: 'csv' | 'manual' | 'receipt';
  transferStatus: TransferStatus;
  transferPairId: string | null; // R16.7：有配对但 transfer_status = none 时显示小标签
  account: { id: string; name: string };
  splits: SplitView[]; // 主拆分在前，其他按金额绝对值从大到小
  possibleDuplicate: boolean; // R17.6：现在还要显示"可能重复"
  duplicatePartners: DuplicatePartner[]; // R17.6：和哪几笔可能重复（M6-6 标签上展开）
};

export type TransactionList = {
  items: TransactionListItem[];
  count: number; // 命中的交易笔数（全部页）
  totalCents: number; // R16.5 合计（全部页）
  page: number;
  pageSize: number;
  // R17.6 F8 提示条的 N：还是 pending 的可能重复手动录入。全部数据，不跟着当前筛选变
  duplicatePendingCount: number;
};

export type TransactionDetail = TransactionListItem & {
  balanceCents: number | null;
  note: string | null;
  confirmedAt: Date | null;
  importBatch: { id: string; fileName: string } | null;
  pair: {
    id: string;
    date: string;
    amountCents: number;
    merchant: string;
    account: { id: string; name: string };
  } | null;
  // R17.6：和这笔"可能重复"的其他交易（M6-5 详情页列出来，点了跳过去）
  possibleDuplicates: DuplicatePartner[];
};

export type DuplicatePartner = {
  id: string;
  date: string;
  amountCents: number;
  merchant: string;
  status: TransactionStatus;
  account: { id: string; name: string };
};

// ---------- 条件 ----------

// ILIKE 的 % _ \ 当普通字符
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// 交易本身的条件
// duplicateIds：quick = duplicates 时带"可能重复"标签的交易 id（getPossibleDuplicates 算好传进来）
// 没传就当成没有，quick = duplicates 什么都不命中
type ListExtra = { duplicateIds?: readonly string[] };

function transactionConditions(
  ctx: HouseholdContext,
  f: TransactionFilters,
  today: string,
  extra: ListExtra = {},
): SQL[] {
  const c: SQL[] = [eq(transaction.householdId, ctx.householdId)];
  if (f.period !== undefined) {
    const { start, end } = periodRange(f.period, today); // R10.1
    c.push(gte(transaction.date, start), lte(transaction.date, end));
  }
  if (f.accountId) c.push(eq(transaction.accountId, f.accountId));
  if (f.status) c.push(eq(transaction.status, f.status));
  if (f.merchant) c.push(ilike(transaction.merchant, `%${escapeLike(f.merchant)}%`));
  // 金额范围按交易金额的绝对值，不按拆分（R16.5）
  if (f.minCents !== undefined) c.push(sql`abs(${transaction.amountCents}) >= ${f.minCents}`);
  if (f.maxCents !== undefined) c.push(sql`abs(${transaction.amountCents}) <= ${f.maxCents}`);
  if (f.quick === 'suggested') c.push(eq(transaction.transferStatus, 'suggested'));
  // R17.6：pending 和银行那笔都列出来，方便比对（M6-6）
  if (f.quick === 'duplicates') {
    const ids = extra.duplicateIds ?? [];
    c.push(ids.length > 0 ? inArray(transaction.id, [...ids]) : sql`false`);
  }
  if (f.batchId) c.push(eq(transaction.importBatchId, f.batchId));
  return c;
}

// R16.5 类型按拆分的分类，不看金额正负
function typeCondition(type: TransactionType): SQL {
  switch (type) {
    case 'income':
      return eq(category.kind, 'income');
    case 'expense':
      return or(
        eq(category.kind, 'expense'),
        inArray(category.systemKey, ['cash_withdrawal', 'bank_fee']),
      )!;
    case 'internal_transfer':
      return eq(category.systemKey, 'internal_transfer');
    case 'uncategorized':
      return eq(category.systemKey, 'uncategorized');
  }
}

// 拆分上的条件。用的时候 transaction_split 要 join category（category 也带 household_id）
function splitConditions(ctx: HouseholdContext, f: TransactionFilters): SQL[] {
  const c: SQL[] = [eq(transactionSplit.householdId, ctx.householdId)];
  // 一级包含它所有的二级
  if (f.categoryId) c.push(or(eq(category.id, f.categoryId), eq(category.parentId, f.categoryId))!);
  if (f.memberId) c.push(eq(transactionSplit.memberId, f.memberId));
  if (f.type) c.push(typeCondition(f.type));
  if (f.isPreTax !== undefined) c.push(eq(transactionSplit.isPreTax, f.isPreTax));
  if (f.quick === 'uncategorized') c.push(eq(category.systemKey, 'uncategorized'));
  return c;
}

const splitCategoryJoin = (ctx: HouseholdContext) =>
  and(eq(category.id, transactionSplit.categoryId), eq(category.householdId, ctx.householdId));

// 列表用的 where：交易条件 + 有拆分条件时 EXISTS 一个命中的拆分
function listWhere(
  ctx: HouseholdContext,
  f: TransactionFilters,
  today: string,
  extra: ListExtra = {},
): SQL {
  const c = transactionConditions(ctx, f, today, extra);
  if (hasSplitFilter(f)) {
    c.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(transactionSplit)
          .innerJoin(category, splitCategoryJoin(ctx))
          .where(
            and(eq(transactionSplit.transactionId, transaction.id), ...splitConditions(ctx, f)),
          ),
      ),
    );
  }
  return and(...c)!;
}

// R16.5 合计：有拆分条件时只加命中的拆分，否则是交易金额之和
async function totalCents(
  ctx: HouseholdContext,
  f: TransactionFilters,
  today: string,
  extra: ListExtra = {},
): Promise<number> {
  const sumOf = (column: typeof transaction.amountCents | typeof transactionSplit.amountCents) =>
    sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

  if (!hasSplitFilter(f)) {
    const [row] = await db
      .select({ sum: sumOf(transaction.amountCents) })
      .from(transaction)
      .where(and(...transactionConditions(ctx, f, today, extra)));
    return row.sum;
  }
  const [row] = await db
    .select({ sum: sumOf(transactionSplit.amountCents) })
    .from(transaction)
    .innerJoin(transactionSplit, eq(transactionSplit.transactionId, transaction.id))
    .innerJoin(category, splitCategoryJoin(ctx))
    .where(and(...transactionConditions(ctx, f, today, extra), ...splitConditions(ctx, f)));
  return row.sum;
}

// ---------- 拆分 ----------

const parentCategory = alias(category, 'parent_category');

// 一批交易的所有拆分，按交易分组。主拆分在前，其他按金额绝对值从大到小
async function loadSplits(
  ctx: HouseholdContext,
  transactionIds: readonly string[],
): Promise<Map<string, SplitView[]>> {
  const out = new Map<string, SplitView[]>(transactionIds.map((id) => [id, []]));
  if (transactionIds.length === 0) return out;

  const rows = await db
    .select({
      transactionId: transactionSplit.transactionId,
      id: transactionSplit.id,
      isPrimary: transactionSplit.isPrimary,
      amountCents: transactionSplit.amountCents,
      categorySource: transactionSplit.categorySource,
      memberSource: transactionSplit.memberSource,
      isPreTax: transactionSplit.isPreTax,
      note: transactionSplit.note,
      categoryId: category.id,
      categoryNameEn: category.nameEn,
      categoryNameZh: category.nameZh,
      categoryKind: category.kind,
      categorySystemKey: category.systemKey,
      parentId: parentCategory.id,
      parentNameEn: parentCategory.nameEn,
      parentNameZh: parentCategory.nameZh,
      memberId: member.id,
      memberName: member.name,
    })
    .from(transactionSplit)
    .innerJoin(category, splitCategoryJoin(ctx))
    .leftJoin(
      parentCategory,
      and(
        eq(parentCategory.id, category.parentId),
        eq(parentCategory.householdId, ctx.householdId),
      ),
    )
    .innerJoin(
      member,
      and(eq(member.id, transactionSplit.memberId), eq(member.householdId, ctx.householdId)),
    )
    .where(
      and(
        eq(transactionSplit.householdId, ctx.householdId),
        inArray(transactionSplit.transactionId, [...transactionIds]),
      ),
    )
    .orderBy(
      desc(transactionSplit.isPrimary),
      sql`abs(${transactionSplit.amountCents}) desc`,
      asc(transactionSplit.id),
    );

  for (const r of rows) {
    out.get(r.transactionId)?.push({
      id: r.id,
      isPrimary: r.isPrimary,
      amountCents: r.amountCents,
      category: {
        id: r.categoryId,
        nameEn: r.categoryNameEn,
        nameZh: r.categoryNameZh,
        kind: r.categoryKind,
        systemKey: r.categorySystemKey,
        parent:
          r.parentId && r.parentNameEn
            ? { id: r.parentId, nameEn: r.parentNameEn, nameZh: r.parentNameZh }
            : null,
      },
      categorySource: r.categorySource as CategorySource,
      member: { id: r.memberId, name: r.memberName },
      memberSource: r.memberSource as MemberSource,
      isPreTax: r.isPreTax,
      note: r.note,
    });
  }
  return out;
}

// ---------- 列表 ----------

const listColumns = {
  id: transaction.id,
  date: transaction.date,
  amountCents: transaction.amountCents,
  merchant: transaction.merchant,
  rawDescription: transaction.rawDescription,
  cardLast4: transaction.cardLast4,
  status: transaction.status,
  source: transaction.source,
  transferStatus: transaction.transferStatus,
  transferPairId: transaction.transferPairId,
  accountId: financialAccount.id,
  accountName: financialAccount.name,
};

type ListRow = Omit<
  TransactionListItem,
  'account' | 'splits' | 'possibleDuplicate' | 'duplicatePartners'
> & {
  accountId: string;
  accountName: string;
};

function toItem(
  r: ListRow,
  splits: SplitView[],
  duplicatePartners: DuplicatePartner[],
): TransactionListItem {
  return {
    id: r.id,
    date: r.date,
    amountCents: r.amountCents,
    merchant: r.merchant,
    rawDescription: r.rawDescription,
    cardLast4: r.cardLast4,
    status: r.status,
    source: r.source,
    transferStatus: r.transferStatus,
    transferPairId: r.transferPairId,
    account: { id: r.accountId, name: r.accountName },
    splits,
    possibleDuplicate: duplicatePartners.length > 0,
    duplicatePartners,
  };
}

const accountJoin = (ctx: HouseholdContext) =>
  and(
    eq(financialAccount.id, transaction.accountId),
    eq(financialAccount.householdId, ctx.householdId),
  );

// F8 列表：按日期倒序（同一天按录入时间倒序），返回当前页、全部命中的笔数和合计
// today 是 Australia/Melbourne 的今天（页面上用 todayInMelbourne()），R10.1 时间段按它算
export async function listTransactions(
  ctx: HouseholdContext,
  filters: TransactionFilters,
  options: { page?: number; pageSize?: number; today: string },
): Promise<TransactionList> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  // quick = duplicates 要先知道是哪几笔
  const duplicates = await getPossibleDuplicates(ctx);
  const extra: ListExtra = { duplicateIds: [...duplicates.groups.keys()] };
  const where = listWhere(ctx, filters, options.today, extra);

  const [rows, [{ count }], total] = await Promise.all([
    db
      .select(listColumns)
      .from(transaction)
      .innerJoin(financialAccount, accountJoin(ctx))
      .where(where)
      .orderBy(desc(transaction.date), desc(transaction.createdAt), desc(transaction.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(transaction)
      .where(where),
    totalCents(ctx, filters, options.today, extra),
  ]);

  // 这一页带标签的行，对方一次查出来
  const partnerIds = new Set(rows.flatMap((r) => duplicates.groups.get(r.id) ?? []));
  const [splits, partners] = await Promise.all([
    loadSplits(
      ctx,
      rows.map((r) => r.id),
    ),
    loadDuplicatePartners(ctx, [...partnerIds]),
  ]);
  const partnersOf = (id: string) => {
    const ids = duplicates.groups.get(id) ?? [];
    return partners.filter((p) => ids.includes(p.id));
  };
  return {
    items: rows.map((r) => toItem(r, splits.get(r.id) ?? [], partnersOf(r.id))),
    count,
    totalCents: total,
    page,
    pageSize,
    duplicatePendingCount: duplicates.pendingIds.size,
  };
}

// ---------- 快捷条件的笔数 ----------

export type QuickFilterCounts = { uncategorized: number; suggested: number };

// F8 快捷条件 chip 上的数字（M4-7）：全部数据，不跟着当前筛选变，方便一眼看到还有多少要处理
// 和列表用同样的条件：未分类 = 有一个拆分是未分类（R16.5），建议转账 = transfer_status = suggested
export async function countQuickFilters(ctx: HouseholdContext): Promise<QuickFilterCounts> {
  const countWhere = (f: TransactionFilters) =>
    db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(transaction)
      .where(listWhere(ctx, f, '')); // 没有时间段，today 用不到
  const [[uncategorized], [suggested]] = await Promise.all([
    countWhere({ quick: 'uncategorized' }),
    countWhere({ quick: 'suggested' }),
  ]);
  return { uncategorized: uncategorized.count, suggested: suggested.count };
}

// ---------- 详情 ----------

const pairTransaction = alias(transaction, 'pair_transaction');
const pairAccount = alias(financialAccount, 'pair_account');

// 详情：所有拆分、导入批次的文件名、配对的另一半。不是本家庭的或者 id 不合法 → null
export async function getTransaction(
  ctx: HouseholdContext,
  id: string,
): Promise<TransactionDetail | null> {
  if (!z.uuid().safeParse(id).success) return null;

  const [row] = await db
    .select({
      ...listColumns,
      balanceCents: transaction.balanceCents,
      note: transaction.note,
      confirmedAt: transaction.confirmedAt,
      batchId: importBatch.id,
      batchFileName: importBatch.fileName,
      pairId: pairTransaction.id,
      pairDate: pairTransaction.date,
      pairAmountCents: pairTransaction.amountCents,
      pairMerchant: pairTransaction.merchant,
      pairAccountId: pairAccount.id,
      pairAccountName: pairAccount.name,
    })
    .from(transaction)
    .innerJoin(financialAccount, accountJoin(ctx))
    .leftJoin(
      importBatch,
      and(
        eq(importBatch.id, transaction.importBatchId),
        eq(importBatch.householdId, ctx.householdId),
      ),
    )
    .leftJoin(
      pairTransaction,
      and(
        eq(pairTransaction.id, transaction.transferPairId),
        eq(pairTransaction.householdId, ctx.householdId),
      ),
    )
    .leftJoin(
      pairAccount,
      and(
        eq(pairAccount.id, pairTransaction.accountId),
        eq(pairAccount.householdId, ctx.householdId),
      ),
    )
    .where(and(eq(transaction.id, id), eq(transaction.householdId, ctx.householdId)));

  if (!row) return null;
  const [splits, duplicates] = await Promise.all([
    loadSplits(ctx, [row.id]),
    getPossibleDuplicates(ctx),
  ]);
  const partners = await loadDuplicatePartners(ctx, duplicates.groups.get(row.id) ?? []);

  return {
    ...toItem(row, splits.get(row.id) ?? [], partners),
    possibleDuplicates: partners,
    balanceCents: row.balanceCents,
    note: row.note,
    confirmedAt: row.confirmedAt,
    importBatch:
      row.batchId && row.batchFileName ? { id: row.batchId, fileName: row.batchFileName } : null,
    pair:
      row.pairId &&
      row.pairDate &&
      row.pairAmountCents !== null &&
      row.pairMerchant &&
      row.pairAccountId &&
      row.pairAccountName
        ? {
            id: row.pairId,
            date: row.pairDate,
            amountCents: row.pairAmountCents,
            merchant: row.pairMerchant,
            account: { id: row.pairAccountId, name: row.pairAccountName },
          }
        : null,
  };
}

// R17.6 列表标签和详情页列出的"对方"，按日期排
async function loadDuplicatePartners(
  ctx: HouseholdContext,
  ids: readonly string[],
): Promise<DuplicatePartner[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: transaction.id,
      date: transaction.date,
      amountCents: transaction.amountCents,
      merchant: transaction.merchant,
      status: transaction.status,
      accountId: financialAccount.id,
      accountName: financialAccount.name,
    })
    .from(transaction)
    .innerJoin(financialAccount, accountJoin(ctx))
    .where(and(eq(transaction.householdId, ctx.householdId), inArray(transaction.id, [...ids])))
    .orderBy(asc(transaction.date), asc(transaction.id));
  return rows.map(({ accountId, accountName, ...r }) => ({
    ...r,
    account: { id: accountId, name: accountName },
  }));
}

// ---------- 修改（M4-3） ----------
// 字段怎么变由 src/lib/rules/split-edit.ts 的纯函数算，这里负责读、校验、在一个事务里写回

export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// changed = false：值和原来一样，没写库
export type SplitUpdateResult = { ok: true; changed: boolean } | { ok: false; message: string };

export type BulkUpdateInput = { categoryId?: string; memberId?: string };

// updatedCount 包括值本来就一样、没真正写库的
export type BulkUpdateResult =
  { ok: true; updatedCount: number; skippedCount: number } | { ok: false; message: string };

// 批量修改一次最多这么多笔（列表一页的上限）
export const MAX_BULK_SIZE = MAX_PAGE_SIZE;

const bulkInputSchema = z
  .object({
    transactionIds: z.array(z.uuid()).min(1).max(MAX_BULK_SIZE),
    categoryId: z.uuid().optional(),
    memberId: z.uuid().optional(),
  })
  .refine((v) => v.categoryId !== undefined || v.memberId !== undefined, {
    message: '分类和归属人至少改一个',
  });

const INVALID = { ok: false, message: '参数不合法' } as const;
const BAD_CATEGORY = { ok: false, message: '不能选这个分类' } as const;
const BAD_MEMBER = { ok: false, message: '不能选这个归属人' } as const;

// R5.1 重算、R16.3 校验要的家庭配置，只读本家庭的。src/server/rules.ts 也用
// 分类连归档的一起读（拆分可能还指着归档分类），isArchived 算上一级：
// 一级归档了，它的二级也不能选，和 listCategoryTree 一致
export async function loadEditContext(tx: DbTx, ctx: HouseholdContext): Promise<EditContext> {
  const hh = ctx.householdId;
  const categoryRows = await tx
    .select({
      id: category.id,
      parentId: category.parentId,
      nameEn: category.nameEn,
      kind: category.kind,
      systemKey: category.systemKey,
      defaultMemberId: category.defaultMemberId,
      isPreTaxDefault: category.isPreTaxDefault,
      isOther: category.isOther,
      isArchived: category.isArchived,
    })
    .from(category)
    .where(eq(category.householdId, hh));
  const archived = new Set(categoryRows.filter((c) => c.isArchived).map((c) => c.id));
  const categories: EditCategory[] = categoryRows.map((c) => ({
    ...c,
    isArchived: c.isArchived || (c.parentId !== null && archived.has(c.parentId)),
  }));

  const cards: Card[] = await tx
    .select({ id: card.id, accountId: card.accountId, last4: card.last4, memberId: card.memberId })
    .from(card)
    .where(eq(card.householdId, hh));

  const accounts: Account[] = await tx
    .select({
      id: financialAccount.id,
      name: financialAccount.name,
      bank: financialAccount.bank,
      type: financialAccount.type,
      defaultMemberId: financialAccount.defaultMemberId,
      numberSuffix: financialAccount.numberSuffix,
    })
    .from(financialAccount)
    .where(eq(financialAccount.householdId, hh));

  return { categories, cards, accounts };
}

type LockedSplit = EditTarget & { transactionId: string };

// 读拆分和它所属交易的字段（R5 要账户和卡号，R16.2 要转账状态），锁住拆分行直到事务结束
async function lockSplits(tx: DbTx, ctx: HouseholdContext, where: SQL): Promise<LockedSplit[]> {
  const rows = await tx
    .select({
      id: transactionSplit.id,
      transactionId: transactionSplit.transactionId,
      categoryId: transactionSplit.categoryId,
      categorySource: transactionSplit.categorySource,
      memberId: transactionSplit.memberId,
      memberSource: transactionSplit.memberSource,
      isPreTax: transactionSplit.isPreTax,
      accountId: transaction.accountId,
      cardLast4: transaction.cardLast4,
      transferStatus: transaction.transferStatus,
    })
    .from(transactionSplit)
    .innerJoin(
      transaction,
      and(
        eq(transaction.id, transactionSplit.transactionId),
        eq(transaction.householdId, ctx.householdId),
      ),
    )
    .where(and(eq(transactionSplit.householdId, ctx.householdId), where))
    .orderBy(asc(transactionSplit.id))
    .for('update', { of: transactionSplit });
  return rows.map((r) => ({
    ...r,
    categorySource: r.categorySource as CategorySource,
    memberSource: r.memberSource as MemberSource,
  }));
}

function sameSplit(a: EditSplit, b: EditSplit): boolean {
  return (
    a.categoryId === b.categoryId &&
    a.categorySource === b.categorySource &&
    a.memberId === b.memberId &&
    a.memberSource === b.memberSource &&
    a.isPreTax === b.isPreTax
  );
}

// 写回一个拆分可以改的字段（分类、归属人、税前），带 household_id
export async function writeSplit(tx: DbTx, ctx: HouseholdContext, s: EditSplit): Promise<void> {
  await tx
    .update(transactionSplit)
    .set({
      categoryId: s.categoryId,
      categorySource: s.categorySource,
      memberId: s.memberId,
      memberSource: s.memberSource,
      isPreTax: s.isPreTax,
    })
    .where(and(eq(transactionSplit.id, s.id), eq(transactionSplit.householdId, ctx.householdId)));
}

// R16.2：auto、confirmed 转账的分类不能改
function isLockedTransfer(status: TransferStatus): boolean {
  return status === 'auto' || status === 'confirmed';
}

// R16.4 按拆分改分类，主拆分和子拆分都用这个（R16.1）
// category_source = manual，is_pre_tax 按新分类默认，归属人按 R5.1 重算（manual 不动）
// 分类没变 → 什么都不写；auto / confirmed 转账（R16.2）、不可选的分类（R16.3）→ ok: false
export async function updateSplitCategory(
  ctx: HouseholdContext,
  splitId: string,
  categoryId: string,
): Promise<SplitUpdateResult> {
  if (!z.uuid().safeParse(splitId).success || !z.uuid().safeParse(categoryId).success) {
    return INVALID;
  }
  return db.transaction(async (tx) => {
    const [target] = await lockSplits(tx, ctx, eq(transactionSplit.id, splitId));
    if (!target) return { ok: false, message: '找不到这个拆分' };

    // 别的家庭的分类不在 editCtx 里，changeCategory 会当成不能选
    const editCtx = await loadEditContext(tx, ctx);
    const r = changeCategory(target, categoryId, editCtx);
    if (!r.ok) return r;
    if (r.changed) await writeSplit(tx, ctx, r.split);
    return { ok: true, changed: r.changed };
  });
}

// R16.4 按拆分改归属人：member_source = manual。转账行也能改（R16.2）
export async function updateSplitMember(
  ctx: HouseholdContext,
  splitId: string,
  memberId: string,
): Promise<SplitUpdateResult> {
  if (!z.uuid().safeParse(splitId).success || !z.uuid().safeParse(memberId).success) {
    return INVALID;
  }
  if (!(await isActiveMember(ctx, memberId))) return BAD_MEMBER;

  return db.transaction(async (tx) => {
    const [target] = await lockSplits(tx, ctx, eq(transactionSplit.id, splitId));
    if (!target) return { ok: false, message: '找不到这个拆分' };

    const next = changeMember(target, memberId);
    const changed = !sameSplit(target, next);
    if (changed) await writeSplit(tx, ctx, next);
    return { ok: true, changed };
  });
}

// 批量修改，一个事务，中途出错全部回滚
// 跳过：有多个拆分的（R16.1）；改分类时 auto / confirmed 转账整笔跳过，归属人也不改（R16.2）
// 分类、归属人不属于本家庭或不能选（R16.3），或者有交易找不到 → ok: false，一笔都不改
// 同时改分类和归属人：先改分类（R5.1 重算），再把归属人设成手动指定的
export async function bulkUpdate(
  ctx: HouseholdContext,
  transactionIds: readonly string[],
  input: BulkUpdateInput,
): Promise<BulkUpdateResult> {
  const parsed = bulkInputSchema.safeParse({ transactionIds, ...input });
  if (!parsed.success) return INVALID;
  const { categoryId, memberId } = parsed.data;
  const ids = [...new Set(parsed.data.transactionIds)];

  if (memberId !== undefined && !(await isActiveMember(ctx, memberId))) return BAD_MEMBER;

  return db.transaction(async (tx) => {
    const editCtx = await loadEditContext(tx, ctx);
    if (categoryId !== undefined) {
      const c = editCtx.categories.find((x) => x.id === categoryId);
      if (!c || !isSelectableCategory(c)) return BAD_CATEGORY; // R16.3
    }

    const splits = await lockSplits(tx, ctx, inArray(transactionSplit.transactionId, ids));
    const byTx = new Map<string, LockedSplit[]>();
    for (const s of splits) {
      const list = byTx.get(s.transactionId) ?? [];
      list.push(s);
      byTx.set(s.transactionId, list);
    }
    // 不是本家庭的、已经被删掉的（比如撤销了导入）
    if (byTx.size !== ids.length) return { ok: false, message: '有交易找不到了，刷新后再试' };

    let updatedCount = 0;
    let skippedCount = 0;
    for (const id of ids) {
      const txSplits = byTx.get(id)!;
      if (txSplits.length > 1) {
        skippedCount++; // R16.1
        continue;
      }
      const [target] = txSplits;
      if (categoryId !== undefined && isLockedTransfer(target.transferStatus)) {
        skippedCount++; // R16.2
        continue;
      }

      let next: EditSplit = target;
      if (categoryId !== undefined) {
        const r = changeCategory(target, categoryId, editCtx);
        // 分类上面校验过、转账上面跳过了，走到这里说明规则函数和这里对不上
        if (!r.ok) throw new Error(`批量改分类失败: ${r.message}`);
        next = r.split;
      }
      if (memberId !== undefined) next = changeMember(next, memberId);

      if (!sameSplit(target, next)) await writeSplit(tx, ctx, next);
      updatedCount++;
    }
    return { ok: true, updatedCount, skippedCount };
  });
}

// ---------- 建议转账确认和拒绝（M4-5） ----------

export type SuggestionResult = { ok: true } | { ok: false; message: string };

// R6.3 从任意一边发起，两边一起改，一个事务
// 确认：confirmed、内部转账、category_source = manual、配对保留、归属人按 R5.1（结果不变）
// 拒绝：none、配对清空、分类和归属人不变
// 不是 suggested、两笔没有互相配对、确认时有多个拆分 → ok: false，什么都不改
async function resolveSuggestionInDb(
  ctx: HouseholdContext,
  transactionId: string,
  action: 'confirm' | 'reject',
): Promise<SuggestionResult> {
  if (!z.uuid().safeParse(transactionId).success) return INVALID;

  return db.transaction(async (tx) => {
    const lockTxs = (ids: string[]) =>
      tx
        .select({
          id: transaction.id,
          accountId: transaction.accountId,
          cardLast4: transaction.cardLast4,
          transferStatus: transaction.transferStatus,
          transferPairId: transaction.transferPairId,
        })
        .from(transaction)
        .where(and(eq(transaction.householdId, ctx.householdId), inArray(transaction.id, ids)))
        .orderBy(asc(transaction.id))
        .for('update');

    // 先读这一笔拿到另一半的 id，再按 id 顺序一起锁两笔，锁住后再检查一次状态
    const [first] = await lockTxs([transactionId]);
    if (!first) return { ok: false, message: '找不到这笔交易' };
    if (first.transferStatus !== 'suggested' || !first.transferPairId) {
      return { ok: false, message: '不是建议转账' };
    }
    const pairId = first.transferPairId;
    const rows = await lockTxs([transactionId, pairId]);
    const self = rows.find((r) => r.id === transactionId)!;
    const other = rows.find((r) => r.id === pairId);
    if (!other) return { ok: false, message: '配对的另一笔找不到了' };

    const splits = await lockSplits(
      tx,
      ctx,
      inArray(transactionSplit.transactionId, [self.id, other.id]),
    );
    const withSplits = (r: (typeof rows)[number]): SuggestionTx => ({
      ...r,
      splits: splits.filter((s) => s.transactionId === r.id),
    });

    const editCtx = await loadEditContext(tx, ctx);
    const r = resolveSuggestion(withSplits(self), withSplits(other), action, editCtx);
    if (!r.ok) return r;

    for (const side of [r.a, r.b]) {
      await tx
        .update(transaction)
        .set({ transferStatus: side.transferStatus, transferPairId: side.transferPairId })
        .where(
          and(eq(transaction.id, side.transactionId), eq(transaction.householdId, ctx.householdId)),
        );
      for (const s of side.splits) await writeSplit(tx, ctx, s);
    }
    return { ok: true };
  });
}

// R6.3 确认建议转账
export async function confirmSuggestion(
  ctx: HouseholdContext,
  transactionId: string,
): Promise<SuggestionResult> {
  return resolveSuggestionInDb(ctx, transactionId, 'confirm');
}

// R6.3 拒绝建议转账。两笔以后都是旧交易，之后的导入不会再建议
export async function rejectSuggestion(
  ctx: HouseholdContext,
  transactionId: string,
): Promise<SuggestionResult> {
  return resolveSuggestionInDb(ctx, transactionId, 'reject');
}
