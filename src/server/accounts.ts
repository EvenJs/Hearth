// 银行 / 现金账户（financial_account）的数据访问。F1、M1-5
// 输入先用 accountInputSchema 校验，再进这里；这里负责 household 隔离和数据库约束
// 保存带尾号的账户时重新识别旧转账（R6.4，M5.5-3）
import { and, asc, eq, ilike, inArray, isNull, ne, or } from 'drizzle-orm';
import { db } from '@/db';
import { financialAccount, member, transaction, transactionSplit } from '@/db/schema';
import type { AccountType, AccountValues, Bank } from '@/lib/accounts/account-input';
import { planTransferRedetect, type RedetectPlan, type RedetectTx } from '@/lib/rules/transfer';
import type { Account as RuleAccount, CategorySource, MemberSource } from '@/lib/rules/types';
import type { HouseholdContext } from './context';
import { isActiveMember } from './members';
import { loadEditContext, writeSplit, type DbTx } from './transactions';
import { pairHouseholdTransfers } from './transfers';

export type Account = {
  id: string;
  name: string;
  bank: Bank;
  type: AccountType;
  defaultMemberId: string;
  defaultMemberName: string;
  numberSuffix: string | null;
  isArchived: boolean;
};

// 业务错误：Server Action 捕获后转成表单提示
export class AccountError extends Error {
  constructor(
    message: string,
    readonly field?: keyof AccountValues,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

// 默认不含已归档账户
export async function listAccounts(
  ctx: HouseholdContext,
  options: { includeArchived?: boolean } = {},
): Promise<Account[]> {
  const conditions = [eq(financialAccount.householdId, ctx.householdId)];
  if (!options.includeArchived) {
    conditions.push(eq(financialAccount.isArchived, false));
  }
  return db
    .select({
      id: financialAccount.id,
      name: financialAccount.name,
      bank: financialAccount.bank,
      type: financialAccount.type,
      defaultMemberId: financialAccount.defaultMemberId,
      defaultMemberName: member.name,
      numberSuffix: financialAccount.numberSuffix,
      isArchived: financialAccount.isArchived,
    })
    .from(financialAccount)
    .innerJoin(member, eq(member.id, financialAccount.defaultMemberId))
    .where(and(...conditions))
    .orderBy(
      asc(financialAccount.isArchived),
      asc(financialAccount.createdAt),
      asc(financialAccount.name),
    );
}

// R6.4 弹窗里的 N 和 M
export type RedetectPreview = { count: number; keptCount: number };

// 保存结果：redetectedCount 是实际认成内部转账的笔数，pairedCount 是之后 R6.2 配上的对数
export type AccountSaveResult = { redetectedCount: number; pairedCount: number };

export type AccountSaveOptions = {
  // R6.4 弹窗里选了"改"。不传或 false：只保存账户，不动交易
  redetect?: boolean;
};

// 新建账户预览时还没有 id，纯函数里用这个占位（不进 SQL）
const NEW_ACCOUNT_ID = 'new-account';

const NO_REDETECT: RedetectPreview = { count: 0, keptCount: 0 };

// R6.4 第 1 步的候选：本家庭其他账户里 confirmed、transfer_status = none、没配对的交易，带全部拆分
// 描述不含 TRANSFER / FUNDS TFER 的 R2.2 一定认不出，先在 SQL 里筛掉；剩下的交给纯函数判断
// pending 不参与（和 R6.2 一样，等导入确认时再说）
async function loadRedetectCandidates(
  tx: DbTx,
  ctx: HouseholdContext,
  accountId: string | null, // null = 新建，还没有自己的交易
  lock: boolean,
): Promise<RedetectTx[]> {
  const hh = ctx.householdId;
  const txQuery = tx
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      rawDescription: transaction.rawDescription,
      cardLast4: transaction.cardLast4,
      transferStatus: transaction.transferStatus,
      transferPairId: transaction.transferPairId,
    })
    .from(transaction)
    .where(
      and(
        eq(transaction.householdId, hh),
        eq(transaction.status, 'confirmed'),
        eq(transaction.transferStatus, 'none'),
        isNull(transaction.transferPairId),
        accountId ? ne(transaction.accountId, accountId) : undefined,
        or(
          ilike(transaction.rawDescription, '%TRANSFER%'),
          ilike(transaction.rawDescription, '%FUNDS TFER%'),
        ),
      ),
    )
    .orderBy(asc(transaction.date), asc(transaction.id));
  const txRows = lock ? await txQuery.for('update') : await txQuery;
  if (txRows.length === 0) return [];

  // 主拆分排第一个（planTransferRedetect 按 splits[0] 当主拆分）
  const splitRows = await tx
    .select({
      id: transactionSplit.id,
      transactionId: transactionSplit.transactionId,
      categoryId: transactionSplit.categoryId,
      categorySource: transactionSplit.categorySource,
      memberId: transactionSplit.memberId,
      memberSource: transactionSplit.memberSource,
      isPreTax: transactionSplit.isPreTax,
      isPrimary: transactionSplit.isPrimary,
    })
    .from(transactionSplit)
    .where(
      and(
        eq(transactionSplit.householdId, hh),
        inArray(
          transactionSplit.transactionId,
          txRows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(transactionSplit.id));

  const byTx = new Map<string, RedetectTx['splits'][number][]>();
  for (const sp of [...splitRows].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))) {
    const list = byTx.get(sp.transactionId) ?? [];
    list.push({
      id: sp.id,
      categoryId: sp.categoryId,
      categorySource: sp.categorySource as CategorySource,
      memberId: sp.memberId,
      memberSource: sp.memberSource as MemberSource,
      isPreTax: sp.isPreTax,
    });
    byTx.set(sp.transactionId, list);
  }
  return txRows.map((r) => ({ ...r, splits: byTx.get(r.id) ?? [] }));
}

// R6.4 第 1 到 3 步。accountId 是账户 id，新建预览时是 null
// 账户表里可能还是旧值（预览时）或已经是新值（保存时），planTransferRedetect 以 values 为准
async function planRedetect(
  tx: DbTx,
  ctx: HouseholdContext,
  accountId: string | null,
  values: AccountValues,
  lock: boolean,
): Promise<{ plan: RedetectPlan; editCtx: Awaited<ReturnType<typeof loadEditContext>> } | null> {
  if (!values.numberSuffix) return null; // 尾号是空的不触发
  const editCtx = await loadEditContext(tx, ctx);
  const account: RuleAccount = {
    id: accountId ?? NEW_ACCOUNT_ID,
    name: values.name,
    bank: values.bank,
    type: values.type,
    defaultMemberId: values.defaultMemberId,
    numberSuffix: values.numberSuffix,
  };
  const candidates = await loadRedetectCandidates(tx, ctx, accountId, lock);
  return { plan: planTransferRedetect(account, candidates, editCtx.accounts, editCtx), editCtx };
}

// R6.4 保存前的预览：会认成转账的 N 笔、对上了但不改的 M 笔。只读，新建时 accountId 传 null
export async function previewTransferRedetect(
  ctx: HouseholdContext,
  accountId: string | null,
  values: AccountValues,
): Promise<RedetectPreview> {
  return db.transaction(
    async (tx) => {
      const r = await planRedetect(tx, ctx, accountId, values, false);
      return r ? { count: r.plan.updates.length, keptCount: r.plan.keptCount } : NO_REDETECT;
    },
    { accessMode: 'read only' },
  );
}

// R6.4 第 3、4 步：在保存账户的同一个事务里改交易，再对整个家庭跑 R6.2
// 账户已经写进去了，这里重新算一遍（不用预览时的结果，中间可能又导入过）
async function applyRedetect(
  tx: DbTx,
  ctx: HouseholdContext,
  accountId: string,
  values: AccountValues,
): Promise<AccountSaveResult> {
  const r = await planRedetect(tx, ctx, accountId, values, true);
  if (!r || r.plan.updates.length === 0) return { redetectedCount: 0, pairedCount: 0 };

  for (const u of r.plan.updates) {
    await tx
      .update(transaction)
      .set({ transferStatus: u.transferStatus })
      .where(
        and(eq(transaction.id, u.transactionId), eq(transaction.householdId, ctx.householdId)),
      );
    await writeSplit(tx, ctx, u.split);
  }
  // 只做 R6.2，不产生新的 R6.3 建议
  const transfers = await pairHouseholdTransfers(tx, ctx, r.editCtx, { newIds: new Set() });
  return { redetectedCount: r.plan.updates.length, pairedCount: transfers.pairs.length };
}

export async function createAccount(
  ctx: HouseholdContext,
  values: AccountValues,
  options: AccountSaveOptions = {},
): Promise<AccountSaveResult> {
  await assertMemberInHousehold(ctx, values.defaultMemberId);
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(financialAccount)
        .values({ householdId: ctx.householdId, ...values })
        .returning({ id: financialAccount.id });
      if (!options.redetect) return { redetectedCount: 0, pairedCount: 0 };
      return applyRedetect(tx, ctx, created.id, values);
    });
  } catch (err) {
    throw toAccountError(err);
  }
}

export async function updateAccount(
  ctx: HouseholdContext,
  accountId: string,
  values: AccountValues,
  options: AccountSaveOptions = {},
): Promise<AccountSaveResult> {
  await assertMemberInHousehold(ctx, values.defaultMemberId);
  try {
    return await db.transaction(async (tx) => {
      const updated = await tx
        .update(financialAccount)
        .set(values)
        .where(
          and(
            eq(financialAccount.id, accountId),
            eq(financialAccount.householdId, ctx.householdId),
          ),
        )
        .returning({ id: financialAccount.id });
      if (updated.length === 0) throw new AccountError('账户不存在');
      if (!options.redetect) return { redetectedCount: 0, pairedCount: 0 };
      return applyRedetect(tx, ctx, accountId, values);
    });
  } catch (err) {
    throw toAccountError(err);
  }
}

// 软删除（schema.md：业务数据用 is_archived），archived = false 时恢复
export async function setAccountArchived(
  ctx: HouseholdContext,
  accountId: string,
  archived: boolean,
): Promise<void> {
  const updated = await db
    .update(financialAccount)
    .set({ isArchived: archived })
    .where(
      and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)),
    )
    .returning({ id: financialAccount.id });
  if (updated.length === 0) throw new AccountError('账户不存在');
}

async function assertMemberInHousehold(ctx: HouseholdContext, memberId: string) {
  if (!(await isActiveMember(ctx, memberId))) {
    throw new AccountError('请选择默认归属人', 'defaultMemberId');
  }
}

// 唯一约束 (household_id, name) 冲突 → 名称重复。drizzle 把驱动错误包在 cause 里
function toAccountError(err: unknown): unknown {
  const pgError = (err as { cause?: unknown })?.cause ?? err;
  const { code, constraint } = (pgError ?? {}) as { code?: string; constraint?: string };
  if (code === '23505' && constraint === 'financial_account_household_id_name_unique') {
    return new AccountError('已经有同名账户了', 'name');
  }
  return err;
}
