// R23 账户余额的数据访问（M9-3）：锚点、当前余额、手动校准、本财年利息
// 选锚点、找前一个锚点用 src/lib/rules/balance.ts 的纯函数；交易金额在 SQL 里按 (账户, 日期, 状态) 分组求和
// 每个查询都带 household_id
import { and, count, eq, gt, gte, inArray, isNotNull, lte, or, sum } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '@/db';
import {
  accountBalance,
  category,
  financialAccount,
  importBatch,
  transaction,
  transactionSplit,
} from '@/db/schema';
import type { AccountType, Bank } from '@/lib/accounts/account-input';
import {
  pickAnchor,
  previousAnchor,
  type AccountPurpose,
  type BalanceAnchor,
  type CurrentBalance,
} from '@/lib/rules/balance';
import { periodRange } from '@/lib/rules/periods';
import type { HouseholdContext } from './context';
import type { DbTx } from './transactions';

type Tx = DbTx | typeof db;

// ---------- 返回的形状 ----------

// pdf 锚点的 id 是批次 id，manual 是 account_balance.id
export type StoredAnchor = BalanceAnchor & { id: string };

export type AccountBalance = {
  id: string;
  name: string;
  bank: Bank;
  type: AccountType;
  numberSuffix: string | null;
  purpose: AccountPurpose;
  isArchived: false; // 只返回没归档的（R23.2）
  linkedAccount: { id: string; name: string; isArchived: boolean } | null;
  balance: CurrentBalance | null; // null = 没有锚点，"还没有余额，填一次"
  anchorSource: BalanceAnchor['source'] | null;
  lastCalibrationDiffCents: number | null; // R23.3 卡片："上次校准差"，null 或 0 不显示
  manualBalances: ManualBalance[]; // R23.3 手动填过的余额，日期新的在前，可以删
  interestCents: number; // R23.6 本财年利息
};

export type ManualBalance = { id: string; date: string; balanceCents: number; createdAt: Date };

export type ManualBalanceErrors = Partial<Record<'accountId' | 'date' | 'balanceCents' | 'form', string>>;
export type ManualBalanceFailure = { ok: false; errors: ManualBalanceErrors };
// diffCents：R23.3 差额，null = 前面没锚点，不比较
export type AddManualBalanceResult = { ok: true; id: string; diffCents: number | null } | ManualBalanceFailure;
export type DeleteManualBalanceResult = { ok: true } | ManualBalanceFailure;

// ---------- 锚点 ----------

// R23.1：PDF 批次（closing_balance_cents 不为空）+ 手动填的，按账户分好
export async function loadAnchors(
  tx: Tx,
  ctx: HouseholdContext,
  accountIds: string[],
): Promise<Map<string, StoredAnchor[]>> {
  const byAccount = new Map<string, StoredAnchor[]>(accountIds.map((id) => [id, []]));
  if (accountIds.length === 0) return byAccount;
  const hh = ctx.householdId;
  const [batches, manuals] = await Promise.all([
    tx
      .select({
        id: importBatch.id,
        accountId: importBatch.accountId,
        date: importBatch.dateTo,
        amountCents: importBatch.closingBalanceCents,
        createdAt: importBatch.createdAt,
      })
      .from(importBatch)
      .where(
        and(
          eq(importBatch.householdId, hh),
          inArray(importBatch.accountId, accountIds),
          eq(importBatch.source, 'pdf'),
          isNotNull(importBatch.closingBalanceCents),
        ),
      ),
    tx
      .select({
        id: accountBalance.id,
        accountId: accountBalance.accountId,
        date: accountBalance.date,
        amountCents: accountBalance.balanceCents,
        createdAt: accountBalance.createdAt,
      })
      .from(accountBalance)
      .where(and(eq(accountBalance.householdId, hh), inArray(accountBalance.accountId, accountIds))),
  ]);
  for (const b of batches) {
    byAccount.get(b.accountId)?.push({ ...b, amountCents: b.amountCents!, source: 'pdf' });
  }
  for (const m of manuals) {
    byAccount.get(m.accountId)?.push({ ...m, source: 'manual' });
  }
  return byAccount;
}

// ---------- 交易合计 ----------

type DayTotal = { date: string; status: 'pending' | 'confirmed'; cents: number; count: number };

// 每个账户只要 date > since 的交易，在 SQL 里按 (账户, 日期, 状态) 分组求和，一次查完所有账户
async function loadDayTotals(
  tx: Tx,
  ctx: HouseholdContext,
  since: Map<string, string>,
): Promise<Map<string, DayTotal[]>> {
  const byAccount = new Map<string, DayTotal[]>([...since.keys()].map((id) => [id, []]));
  if (since.size === 0) return byAccount;
  const rows = await tx
    .select({
      accountId: transaction.accountId,
      date: transaction.date,
      status: transaction.status,
      cents: sum(transaction.amountCents).mapWith(Number),
      count: count(),
    })
    .from(transaction)
    .where(
      and(
        eq(transaction.householdId, ctx.householdId),
        or(
          ...[...since].map(([accountId, date]) =>
            and(eq(transaction.accountId, accountId), gt(transaction.date, date)),
          ),
        ),
      ),
    )
    .groupBy(transaction.accountId, transaction.date, transaction.status);
  for (const r of rows) byAccount.get(r.accountId)?.push(r);
  return byAccount;
}

// R23.2：只算 date > 锚点日期的；截至 = max(锚点日期, 之后最晚的交易日期)，pending 也算
function balanceFrom(anchor: StoredAnchor, days: readonly DayTotal[]): CurrentBalance {
  let postedCents = anchor.amountCents;
  let pendingCount = 0;
  let pendingCents = 0;
  let asOf = anchor.date;
  for (const d of days) {
    if (d.date <= anchor.date) continue;
    if (d.status === 'confirmed') {
      postedCents += d.cents;
    } else {
      pendingCount += d.count;
      pendingCents += d.cents;
    }
    if (d.date > asOf) asOf = d.date;
  }
  return { postedCents, availableCents: postedCents + pendingCents, pendingCount, pendingCents, asOf };
}

// R23.3：差额 = 填的数 − (P 的金额 + Σ confirmed，P 日期 < date ≤ 手动日期)。没有 P → null
function diffFrom(
  manual: StoredAnchor,
  previous: StoredAnchor | null,
  days: readonly DayTotal[],
): number | null {
  if (previous === null) return null;
  const sumCents = days
    .filter((d) => d.status === 'confirmed' && d.date > previous.date && d.date <= manual.date)
    .reduce((s, d) => s + d.cents, 0);
  return manual.amountCents - (previous.amountCents + sumCents);
}

// ---------- 利息（R23.6） ----------

// Interest 不是系统分类：按名字找一级 Income 下的 Interest，不区分大小写。含已归档的
async function findInterestCategoryId(tx: Tx, ctx: HouseholdContext): Promise<string | null> {
  const rows = await tx
    .select({ id: category.id, parentId: category.parentId, nameEn: category.nameEn })
    .from(category)
    .where(eq(category.householdId, ctx.householdId));
  const is = (name: string, expected: string) => name.trim().toLowerCase() === expected;
  const incomeIds = new Set(
    rows.filter((c) => c.parentId === null && is(c.nameEn, 'income')).map((c) => c.id),
  );
  const interest = rows.find(
    (c) => c.parentId !== null && incomeIds.has(c.parentId) && is(c.nameEn, 'interest'),
  );
  return interest?.id ?? null;
}

// R23.6：本财年 Income / Interest 的拆分合计，按账户。负数冲减、pending 也算（同 R10）
async function loadInterest(
  tx: Tx,
  ctx: HouseholdContext,
  accountIds: string[],
  today: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const interestId = await findInterestCategoryId(tx, ctx);
  if (interestId === null || accountIds.length === 0) return result;
  const { start, end } = periodRange('this_fy', today);
  const rows = await tx
    .select({
      accountId: transaction.accountId,
      cents: sum(transactionSplit.amountCents).mapWith(Number),
    })
    .from(transactionSplit)
    .innerJoin(transaction, eq(transaction.id, transactionSplit.transactionId))
    .where(
      and(
        eq(transactionSplit.householdId, ctx.householdId),
        eq(transaction.householdId, ctx.householdId),
        eq(transactionSplit.categoryId, interestId),
        inArray(transaction.accountId, accountIds),
        gte(transaction.date, start),
        lte(transaction.date, end),
      ),
    )
    .groupBy(transaction.accountId);
  for (const r of rows) result.set(r.accountId, r.cents);
  return result;
}

// ---------- 账户总览 ----------

// R23.2、R23.3、R23.5、R23.6：所有没归档账户的余额、最近一次手动校准的差额、本财年利息
// 顺序按账户建的先后；分组用 groupByPurpose
export async function getAccountBalances(
  ctx: HouseholdContext,
  today: string,
): Promise<AccountBalance[]> {
  const hh = ctx.householdId;
  const linked = alias(financialAccount, 'linked');
  const accounts = await db
    .select({
      id: financialAccount.id,
      name: financialAccount.name,
      bank: financialAccount.bank,
      type: financialAccount.type,
      numberSuffix: financialAccount.numberSuffix,
      purpose: financialAccount.purpose,
      linkedId: linked.id,
      linkedName: linked.name,
      linkedIsArchived: linked.isArchived,
    })
    .from(financialAccount)
    .leftJoin(
      linked,
      and(eq(linked.id, financialAccount.linkedAccountId), eq(linked.householdId, hh)),
    )
    .where(and(eq(financialAccount.householdId, hh), eq(financialAccount.isArchived, false)))
    .orderBy(financialAccount.createdAt, financialAccount.name);
  const ids = accounts.map((a) => a.id);

  const [anchors, interest] = await Promise.all([
    loadAnchors(db, ctx, ids),
    loadInterest(db, ctx, ids, today),
  ]);

  // 每个账户：当前锚点、最近一次手动校准和它的前一个锚点。交易只要查到其中最早的日期之后
  const picked = new Map<
    string,
    { anchor: StoredAnchor; lastManual: StoredAnchor | null; previous: StoredAnchor | null }
  >();
  const since = new Map<string, string>();
  for (const id of ids) {
    const list = anchors.get(id) ?? [];
    const anchor = pickAnchor(list);
    if (anchor === null) continue;
    const lastManual = pickAnchor(list.filter((a) => a.source === 'manual'));
    const previous = lastManual ? previousAnchor(lastManual, list) : null;
    picked.set(id, { anchor, lastManual, previous });
    since.set(id, previous && previous.date < anchor.date ? previous.date : anchor.date);
  }
  const days = await loadDayTotals(db, ctx, since);

  return accounts.map((a) => {
    const p = picked.get(a.id);
    const d = days.get(a.id) ?? [];
    const manualBalances = (anchors.get(a.id) ?? [])
      .filter((m) => m.source === 'manual')
      .map((m) => ({ id: m.id, date: m.date, balanceCents: m.amountCents, createdAt: m.createdAt }))
      .sort((x, y) =>
        x.date === y.date ? y.createdAt.getTime() - x.createdAt.getTime() : x.date < y.date ? 1 : -1,
      );
    return {
      id: a.id,
      name: a.name,
      bank: a.bank,
      type: a.type,
      numberSuffix: a.numberSuffix,
      purpose: a.purpose,
      isArchived: false,
      linkedAccount:
        a.linkedId === null
          ? null
          : { id: a.linkedId, name: a.linkedName!, isArchived: a.linkedIsArchived! },
      balance: p ? balanceFrom(p.anchor, d) : null,
      anchorSource: p?.anchor.source ?? null,
      lastCalibrationDiffCents: p?.lastManual ? diffFrom(p.lastManual, p.previous, d) : null,
      manualBalances,
      interestCents: interest.get(a.id) ?? 0,
    };
  });
}

// ---------- 手动校准（R23.3） ----------

const manualBalanceSchema = z.object({
  accountId: z.uuid(),
  date: z.iso.date(),
  balanceCents: z.number().int().min(-2147483648).max(2147483647),
});

export type ManualBalanceInput = z.input<typeof manualBalanceSchema>;

function shapeErrors(error: z.ZodError): ManualBalanceFailure {
  const errors: ManualBalanceErrors = {};
  for (const issue of error.issues) {
    const key = (issue.path[0] ?? 'form') as keyof ManualBalanceErrors;
    errors[key] ??= '参数不合法';
  }
  return { ok: false, errors };
}

// R23.3：日期不能晚于今天；归档的账户不能填；照样保存，返回差额（实时算，不存）
export async function addManualBalance(
  ctx: HouseholdContext,
  input: ManualBalanceInput,
  today: string,
): Promise<AddManualBalanceResult> {
  const parsed = manualBalanceSchema.safeParse(input);
  if (!parsed.success) return shapeErrors(parsed.error);
  const { accountId, date, balanceCents } = parsed.data;
  if (date > today) return { ok: false, errors: { date: '日期不能晚于今天' } };

  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ isArchived: financialAccount.isArchived })
      .from(financialAccount)
      .where(and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)))
      .for('update');
    if (!account) return { ok: false, errors: { accountId: '找不到这个账户' } };
    if (account.isArchived) return { ok: false, errors: { accountId: '已归档的账户不能填余额' } };

    const [row] = await tx
      .insert(accountBalance)
      .values({ householdId: ctx.householdId, accountId, date, balanceCents, createdBy: ctx.userId })
      .returning({ id: accountBalance.id });

    const list = (await loadAnchors(tx, ctx, [accountId])).get(accountId) ?? [];
    const manual = list.find((a) => a.source === 'manual' && a.id === row.id)!;
    const previous = previousAnchor(manual, list);
    const days = previous
      ? ((await loadDayTotals(tx, ctx, new Map([[accountId, previous.date]]))).get(accountId) ?? [])
      : [];
    return { ok: true, id: row.id, diffCents: diffFrom(manual, previous, days) };
  });
}

// R23.3：只能删，不能改。别的家庭的当成不存在
export async function deleteManualBalance(
  ctx: HouseholdContext,
  id: string,
): Promise<DeleteManualBalanceResult> {
  const notFound: ManualBalanceFailure = { ok: false, errors: { form: '找不到这条余额' } };
  if (!z.uuid().safeParse(id).success) return notFound;
  const deleted = await db
    .delete(accountBalance)
    .where(and(eq(accountBalance.id, id), eq(accountBalance.householdId, ctx.householdId)))
    .returning({ id: accountBalance.id });
  return deleted.length === 0 ? notFound : { ok: true };
}

// R23.1：新建账户时的开户余额锚点，和建账户在同一个事务里写
export async function insertOpeningBalance(
  tx: DbTx,
  ctx: HouseholdContext,
  accountId: string,
  date: string,
  balanceCents: number,
): Promise<void> {
  await tx
    .insert(accountBalance)
    .values({ householdId: ctx.householdId, accountId, date, balanceCents, createdBy: ctx.userId });
}
