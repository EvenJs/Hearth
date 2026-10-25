// F8 流水查询里改拆分：手动改分类和归属人（R16.4、R5.1）、转账行限制（R16.2）、
// 分类下拉可选项（R16.3）、交易类型（R16.5）、重新应用规则（R7.2）
// 函数只算出要写的字段，入库（一个事务）由 src/server/ 做
// 纯函数，不 import 数据库和 Next.js
import { bySystemKey, classify } from './classify';
import { recomputeMember, type MemberContext } from './member';
import type { Category, CategoryRule, CategorySource, MemberSource, TransferStatus } from './types';

// ---------- 类型 ----------

// transaction_split 上可以改的字段
export type EditSplit = {
  id: string;
  categoryId: string;
  categorySource: CategorySource;
  memberId: string;
  memberSource: MemberSource;
  isPreTax: boolean;
};

// 拆分所属交易的字段：R5 重算要账户和卡号，R16.2 要转账状态
export type EditTx = {
  accountId: string;
  cardLast4: string | null;
  transferStatus: TransferStatus;
};

export type EditTarget = EditSplit & EditTx;

// R16.3 要知道分类是否归档。Category 类型里没有这个字段，这里单独加，不传当成没归档
export type EditCategory = Category & { isArchived?: boolean };

export type EditContext = MemberContext & {
  categories: readonly EditCategory[];
};

// changed = false：新旧分类相同，什么都没改
export type EditResult =
  { ok: true; split: EditSplit; changed: boolean } | { ok: false; message: string };

function pickSplit(s: EditSplit): EditSplit {
  return {
    id: s.id,
    categoryId: s.categoryId,
    categorySource: s.categorySource,
    memberId: s.memberId,
    memberSource: s.memberSource,
    isPreTax: s.isPreTax,
  };
}

// ---------- R16.3 ----------

// R16.3：expense、income（一级和二级）和未分类、现金支出、银行费用能选；内部转账和归档的不能选
export function isSelectableCategory(c: EditCategory): boolean {
  if (c.isArchived) return false;
  return c.systemKey !== 'internal_transfer';
}

// R16.3 分类下拉的可选项，保持输入顺序
export function selectableCategories<T extends EditCategory>(categories: readonly T[]): T[] {
  return categories.filter(isSelectableCategory);
}

// ---------- R16.5 ----------

export const TRANSACTION_TYPES = [
  'income',
  'expense',
  'internal_transfer',
  'uncategorized',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

// R16.5：类型按 R10 的分类口径，不看金额正负
export function typeOfCategory(c: Category): TransactionType {
  if (c.kind === 'income') return 'income';
  if (c.kind === 'expense') return 'expense';
  switch (c.systemKey) {
    case 'cash_withdrawal':
    case 'bank_fee':
      return 'expense';
    case 'internal_transfer':
      return 'internal_transfer';
    case 'uncategorized':
      return 'uncategorized';
    default:
      throw new Error(`系统分类没有 systemKey: ${c.id}`);
  }
}

// ---------- R16.4、R16.2、R5.1 ----------

// 分类改变后的字段：is_pre_tax 按新分类默认（R7），归属人按 R5.1 重算（manual 不动）
function withCategory(
  target: EditTarget,
  category: Category,
  categorySource: CategorySource,
  ctx: MemberContext,
): EditSplit {
  const member = recomputeMember(
    {
      memberId: target.memberId,
      memberSource: target.memberSource,
      accountId: target.accountId,
      cardLast4: target.cardLast4,
    },
    category.id,
    ctx,
  );
  return {
    ...pickSplit(target),
    categoryId: category.id,
    categorySource,
    isPreTax: category.isPreTaxDefault,
    ...member,
  };
}

// R16.4 手动改分类：category_source = manual，is_pre_tax 按新分类默认，归属人按 R5.1 重算
// 新旧分类相同 → 原样返回（R5.1 只在分类改变时重算）
// R16.2：auto、confirmed 转账不能改分类；R16.3：内部转账、归档的、不存在的分类不能选
export function changeCategory(
  target: EditTarget,
  newCategoryId: string,
  ctx: EditContext,
): EditResult {
  if (target.categoryId === newCategoryId) {
    return { ok: true, split: pickSplit(target), changed: false };
  }
  if (target.transferStatus === 'auto' || target.transferStatus === 'confirmed') {
    return { ok: false, message: '内部转账的分类不能改，只能改归属人' };
  }
  const category = ctx.categories.find((c) => c.id === newCategoryId);
  if (!category || !isSelectableCategory(category)) {
    return { ok: false, message: '不能选这个分类' };
  }
  return {
    ok: true,
    split: withCategory(target, category, 'manual', ctx),
    changed: true,
  };
}

// R16.4 手动改归属人：member_source = manual。转账行也能改（R16.2）
export function changeMember(split: EditSplit, memberId: string): EditSplit {
  return { ...pickSplit(split), memberId, memberSource: 'manual' };
}

// ---------- R7.2 ----------

// 重新应用规则需要的交易字段
export type ReapplyTx = EditTx & {
  id: string;
  merchant: string; // R3 清洗后的
  splits: readonly EditSplit[];
};

export type ReapplyPlan = {
  updates: { transactionId: string; split: EditSplit }[];
  skipped: number; // 有多个拆分跳过的交易笔数
};

// R7.2：只动 category_source = rule 的和未分类的（未分类的来源是 system）
// 其他 system 的（内部转账、现金支出、银行费用）和 manual 的不动
function reapplicable(s: EditSplit, uncategorizedId: string): boolean {
  if (s.categorySource === 'rule') return true;
  return s.categorySource === 'system' && s.categoryId === uncategorizedId;
}

// R7.2 重新应用规则：多拆分的跳过并计数；按 R7 重新分类，分类变了的才返回，归属人按 R5.1 重算
export function planReapply(
  txs: readonly ReapplyTx[],
  rules: readonly CategoryRule[],
  ctx: MemberContext,
): ReapplyPlan {
  const uncategorized = bySystemKey(ctx.categories, 'uncategorized');
  const plan: ReapplyPlan = { updates: [], skipped: 0 };

  for (const tx of txs) {
    if (tx.splits.length > 1) {
      plan.skipped++;
      continue;
    }
    const [split] = tx.splits;
    if (!split || !reapplicable(split, uncategorized.id)) continue;

    // 能走到这里的不是内部转账（内部转账是 system 来源，上面已经排除）
    const result = classify(
      { merchant: tx.merchant, isInternalTransfer: false },
      rules,
      ctx.categories,
    );
    if (result.categoryId === split.categoryId) continue;

    const category = ctx.categories.find((c) => c.id === result.categoryId)!;
    plan.updates.push({
      transactionId: tx.id,
      split: withCategory({ ...tx, ...split }, category, result.categorySource, ctx),
    });
  }
  return plan;
}
