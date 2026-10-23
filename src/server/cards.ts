// 卡号映射（card）的数据访问。F1、M1-6
// 卡号后四位 → 归属人，导入时用于 R5 第 3 优先级。删除是硬删除：
// card 表没有 is_archived，交易里只存 card_last4，不引用 card.id
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { card, financialAccount, member } from '@/db/schema';
import type { CardValues } from '@/lib/accounts/card-input';
import type { HouseholdContext } from './context';
import { isActiveMember } from './members';

export type Card = {
  id: string;
  accountId: string;
  last4: string;
  memberId: string;
  memberName: string;
  label: string | null;
};

export class CardError extends Error {
  constructor(
    message: string,
    readonly field?: keyof CardValues,
  ) {
    super(message);
    this.name = 'CardError';
  }
}

// 本 household 所有账户的卡，按账户、后四位排
export async function listCards(ctx: HouseholdContext): Promise<Card[]> {
  return db
    .select({
      id: card.id,
      accountId: card.accountId,
      last4: card.last4,
      memberId: card.memberId,
      memberName: member.name,
      label: card.label,
    })
    .from(card)
    .innerJoin(member, eq(member.id, card.memberId))
    .where(eq(card.householdId, ctx.householdId))
    .orderBy(asc(card.accountId), asc(card.last4));
}

export async function createCard(
  ctx: HouseholdContext,
  accountId: string,
  values: CardValues,
): Promise<void> {
  const [account] = await db
    .select({ id: financialAccount.id })
    .from(financialAccount)
    .where(
      and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)),
    );
  if (!account) throw new CardError('账户不存在');
  if (!(await isActiveMember(ctx, values.memberId))) {
    throw new CardError('请选择归属人', 'memberId');
  }

  try {
    await db.insert(card).values({ householdId: ctx.householdId, accountId, ...values });
  } catch (err) {
    // 唯一约束 (account_id, last4)：同一账户下后四位不能重复。drizzle 把驱动错误包在 cause 里
    const pgError = (err as { cause?: unknown })?.cause ?? err;
    const { code, constraint } = (pgError ?? {}) as { code?: string; constraint?: string };
    if (code === '23505' && constraint === 'card_account_id_last4_unique') {
      throw new CardError(`这个账户已经有后四位 ${values.last4} 的卡了`, 'last4');
    }
    throw err;
  }
}

export async function deleteCard(ctx: HouseholdContext, cardId: string): Promise<void> {
  const deleted = await db
    .delete(card)
    .where(and(eq(card.id, cardId), eq(card.householdId, ctx.householdId)))
    .returning({ id: card.id });
  if (deleted.length === 0) throw new CardError('卡不存在');
}
