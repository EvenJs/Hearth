// F8 流水查询（M4-2）：列表、笔数和合计、详情
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
  category,
  financialAccount,
  importBatch,
  member,
  transaction,
  transactionSplit,
} from '@/db/schema';
import { periodRange } from '@/lib/rules/periods';
import type { TransactionType } from '@/lib/rules/split-edit';
import type {
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
};

export type TransactionList = {
  items: TransactionListItem[];
  count: number; // 命中的交易笔数（全部页）
  totalCents: number; // R16.5 合计（全部页）
  page: number;
  pageSize: number;
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
};

// ---------- 条件 ----------

// ILIKE 的 % _ \ 当普通字符
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// 交易本身的条件
function transactionConditions(ctx: HouseholdContext, f: TransactionFilters, today: string): SQL[] {
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
function listWhere(ctx: HouseholdContext, f: TransactionFilters, today: string): SQL {
  const c = transactionConditions(ctx, f, today);
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
): Promise<number> {
  const sumOf = (column: typeof transaction.amountCents | typeof transactionSplit.amountCents) =>
    sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

  if (!hasSplitFilter(f)) {
    const [row] = await db
      .select({ sum: sumOf(transaction.amountCents) })
      .from(transaction)
      .where(and(...transactionConditions(ctx, f, today)));
    return row.sum;
  }
  const [row] = await db
    .select({ sum: sumOf(transactionSplit.amountCents) })
    .from(transaction)
    .innerJoin(transactionSplit, eq(transactionSplit.transactionId, transaction.id))
    .innerJoin(category, splitCategoryJoin(ctx))
    .where(and(...transactionConditions(ctx, f, today), ...splitConditions(ctx, f)));
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

type ListRow = Omit<TransactionListItem, 'account' | 'splits'> & {
  accountId: string;
  accountName: string;
};

function toItem(r: ListRow, splits: SplitView[]): TransactionListItem {
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
  const where = listWhere(ctx, filters, options.today);

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
    totalCents(ctx, filters, options.today),
  ]);

  const splits = await loadSplits(
    ctx,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((r) => toItem(r, splits.get(r.id) ?? [])),
    count,
    totalCents: total,
    page,
    pageSize,
  };
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
  const splits = await loadSplits(ctx, [row.id]);

  return {
    ...toItem(row, splits.get(row.id) ?? []),
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
