// 银行 / 现金账户（financial_account）的数据访问。F1、M1-5
// 输入先用 accountInputSchema 校验，再进这里；这里负责 household 隔离和数据库约束
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { financialAccount, member } from '@/db/schema';
import type { AccountType, AccountValues, Bank } from '@/lib/accounts/account-input';
import type { HouseholdContext } from './context';

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

export async function createAccount(ctx: HouseholdContext, values: AccountValues): Promise<void> {
  await assertMemberInHousehold(ctx, values.defaultMemberId);
  try {
    await db.insert(financialAccount).values({ householdId: ctx.householdId, ...values });
  } catch (err) {
    throw toAccountError(err);
  }
}

export async function updateAccount(
  ctx: HouseholdContext,
  accountId: string,
  values: AccountValues,
): Promise<void> {
  await assertMemberInHousehold(ctx, values.defaultMemberId);
  let updated: { id: string }[];
  try {
    updated = await db
      .update(financialAccount)
      .set(values)
      .where(
        and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)),
      )
      .returning({ id: financialAccount.id });
  } catch (err) {
    throw toAccountError(err);
  }
  if (updated.length === 0) throw new AccountError('账户不存在');
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

// 归属人必须属于当前 household 且没归档，防止表单被改成别家的 member id
async function assertMemberInHousehold(ctx: HouseholdContext, memberId: string) {
  const [m] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.id, memberId),
        eq(member.householdId, ctx.householdId),
        eq(member.isArchived, false),
      ),
    );
  if (!m) throw new AccountError('请选择默认归属人', 'defaultMemberId');
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
