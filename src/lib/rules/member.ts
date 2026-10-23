// R5 归属人、R5.1 分类改变时重算（business-rules.md R5、R5.1）
// 归属人是"钱用在谁身上"，不是谁付的钱：分类默认优先于卡号
// R5 在 R7 分类之后执行。纯函数，不 import 数据库和 Next.js
import type { Account, Card, Category, MemberSource } from './types';

export type MemberContext = {
  categories: readonly Category[];
  cards: readonly Card[];
  accounts: readonly Account[];
};

export type MemberInput = {
  accountId: string;
  cardLast4: string | null; // R2.1
  categoryId: string; // R7 的结果
  manualMemberId?: string | null; // 手动录入或 F8 改过
};

export type MemberResult = {
  memberId: string;
  memberSource: MemberSource;
};

function findCategory(categories: readonly Category[], id: string): Category {
  const c = categories.find((x) => x.id === id);
  if (!c) throw new Error(`分类不存在: ${id}`);
  return c;
}

// R5 第 2 优先级：二级的 default_member_id，为空时用一级的
// 系统分类和 Uncategorised 没有分类默认
export function categoryDefaultMember(
  categoryId: string,
  categories: readonly Category[],
): string | null {
  const c = findCategory(categories, categoryId);
  if (c.kind === 'system') return null;
  if (c.defaultMemberId) return c.defaultMemberId;
  if (c.parentId === null) return null;
  return findCategory(categories, c.parentId).defaultMemberId;
}

// R5 第 3 优先级：card 表里 (account_id, card_last4) 对应的归属人
function cardMember(accountId: string, cardLast4: string | null, cards: readonly Card[]) {
  if (!cardLast4) return null;
  return cards.find((c) => c.accountId === accountId && c.last4 === cardLast4)?.memberId ?? null;
}

// R5：按优先级 manual → category → card → account
export function resolveMember(input: MemberInput, ctx: MemberContext): MemberResult {
  if (input.manualMemberId) return { memberId: input.manualMemberId, memberSource: 'manual' };

  const fromCategory = categoryDefaultMember(input.categoryId, ctx.categories);
  if (fromCategory) return { memberId: fromCategory, memberSource: 'category' };

  const fromCard = cardMember(input.accountId, input.cardLast4, ctx.cards);
  if (fromCard) return { memberId: fromCard, memberSource: 'card' };

  const account = ctx.accounts.find((a) => a.id === input.accountId);
  if (!account) throw new Error(`账户不存在: ${input.accountId}`);
  return { memberId: account.defaultMemberId, memberSource: 'account' };
}

export type CurrentMember = MemberResult & {
  accountId: string;
  cardLast4: string | null;
};

// R5.1：分类变了，manual 的永远不动，其他按新分类走 R5 重算
// 调用方负责判断"分类确实变了"和 pending 确认除外的情况
export function recomputeMember(
  current: CurrentMember,
  newCategoryId: string,
  ctx: MemberContext,
): MemberResult {
  if (current.memberSource === 'manual') {
    return { memberId: current.memberId, memberSource: 'manual' };
  }
  return resolveMember(
    { accountId: current.accountId, cardLast4: current.cardLast4, categoryId: newCategoryId },
    ctx,
  );
}
