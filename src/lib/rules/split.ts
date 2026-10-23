// R15 简单拆分：拆出一部分（R15.2）、改金额和删除（R15.3）
// 函数只算出新的拆分列表，入库（一个事务）由调用方做：id 为 null 的是新建的，不在列表里的是删除的
// 纯函数，不 import 数据库和 Next.js
import { resolveMember, type MemberContext } from './member';
import { formatAud } from './money';
import type { CategorySource, MemberSource } from './types';

export type SplitRow = {
  id: string | null; // null = 新拆分，还没入库
  isPrimary: boolean;
  amountCents: number; // 和交易同符号
  categoryId: string;
  categorySource: CategorySource;
  memberId: string;
  memberSource: MemberSource;
  isPreTax: boolean;
  note: string | null;
};

// 拆分需要的交易字段
export type SplitTx = {
  accountId: string;
  cardLast4: string | null; // R5 卡号映射用
  amountCents: number;
  splits: readonly SplitRow[];
};

export type SplitResult = { ok: true; splits: SplitRow[] } | { ok: false; message: string };

export type AddSplitInput = {
  amountCents: number; // 用户填正数，按交易符号转换
  categoryId: string;
  memberId?: string | null; // 不选就按 R5 算
  note?: string | null;
};

function fail(message: string): SplitResult {
  return { ok: false, message };
}

function primaryOf(tx: SplitTx): SplitRow {
  const primaries = tx.splits.filter((s) => s.isPrimary);
  if (primaries.length !== 1)
    throw new Error(`交易必须恰好有一个主拆分，现在有 ${primaries.length} 个`);
  return primaries[0];
}

function isPositiveCents(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

// 换掉主拆分的金额，其他拆分原样
function withPrimaryAmount(splits: readonly SplitRow[], amountCents: number): SplitRow[] {
  return splits.map((s) => (s.isPrimary ? { ...s, amountCents } : { ...s }));
}

// R15.2：从主拆分拆出一部分
export function addSplit(tx: SplitTx, input: AddSplitInput, ctx: MemberContext): SplitResult {
  const primary = primaryOf(tx);
  const sign = Math.sign(tx.amountCents);
  const available = Math.abs(primary.amountCents);

  if (!isPositiveCents(input.amountCents)) return fail('拆出金额必须大于 0');
  // 主拆分不能变成 0 或反号
  if (input.amountCents >= available) {
    return fail(`拆出金额必须小于主拆分当前金额 ${formatAud(available)}`);
  }

  const category = ctx.categories.find((c) => c.id === input.categoryId);
  if (!category) throw new Error(`分类不存在: ${input.categoryId}`);

  // 选了归属人 → manual；没选 → R5（分类默认 > 卡号 > 账户）
  const member = resolveMember(
    {
      accountId: tx.accountId,
      cardLast4: tx.cardLast4,
      categoryId: input.categoryId,
      manualMemberId: input.memberId ?? null,
    },
    ctx,
  );

  const newSplit: SplitRow = {
    id: null,
    isPrimary: false,
    amountCents: sign * input.amountCents,
    categoryId: input.categoryId,
    categorySource: 'manual',
    memberId: member.memberId,
    memberSource: member.memberSource,
    isPreTax: category.isPreTaxDefault,
    note: input.note ?? null,
  };

  return {
    ok: true,
    splits: [...withPrimaryAmount(tx.splits, primary.amountCents - newSplit.amountCents), newSplit],
  };
}

function findNonPrimary(tx: SplitTx, splitId: string): SplitRow | string {
  const split = tx.splits.find((s) => s.id === splitId);
  if (!split) return `拆分不存在: ${splitId}`;
  if (split.isPrimary) return '主拆分不能改金额或删除，只能改分类和归属人';
  return split;
}

// R15.3：改非主拆分的金额，差额从主拆分补或扣。amountCents 是用户填的正数
export function updateSplitAmount(tx: SplitTx, splitId: string, amountCents: number): SplitResult {
  const split = findNonPrimary(tx, splitId);
  if (typeof split === 'string') return fail(split);
  if (!isPositiveCents(amountCents)) return fail('拆分金额必须大于 0');

  const primary = primaryOf(tx);
  const sign = Math.sign(tx.amountCents);
  // 主拆分 + 这一笔原来的金额 = 这一笔最多能有多少（不含），主拆分不能变成 0 或反号
  const available = Math.abs(primary.amountCents) + Math.abs(split.amountCents);
  if (amountCents >= available) {
    return fail(`拆分金额必须小于 ${formatAud(available)}（主拆分不能变成 0）`);
  }

  const newAmount = sign * amountCents;
  const newPrimary = primary.amountCents + split.amountCents - newAmount;
  return {
    ok: true,
    splits: withPrimaryAmount(tx.splits, newPrimary).map((s) =>
      s.id === splitId ? { ...s, amountCents: newAmount } : s,
    ),
  };
}

// R15.3：删除非主拆分，金额全部加回主拆分
export function removeSplit(tx: SplitTx, splitId: string): SplitResult {
  const split = findNonPrimary(tx, splitId);
  if (typeof split === 'string') return fail(split);

  const primary = primaryOf(tx);
  return {
    ok: true,
    splits: withPrimaryAmount(tx.splits, primary.amountCents + split.amountCents).filter(
      (s) => s.id !== splitId,
    ),
  };
}
