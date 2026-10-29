// 小票按分类拆分（business-rules.md R20.3、R5、R15.1）
// 函数只算出要写的拆分，入库（一个事务）由 src/server/ 做
// 纯函数，不 import 数据库和 Next.js
import { bySystemKey } from './classify';
import { recomputeMember, resolveMember, type MemberContext } from './member';
import { formatAud } from './money';
import { checkReceipt, type NormalizedReceipt, type ReceiptItem } from './receipt';
import type { SplitRow, SplitTx } from './split';
import type { Category } from './types';

// ---------- 类型 ----------

// 一个分类的合计，小票方向（正数）
export type ReceiptGroup = { categoryId: string; amountCents: number };

// primary：更新原来的主拆分（id 不变）；created：新建（id 为 null）；deletedIds：原来的非主拆分
export type ReceiptSplitPlan =
  | { ok: true; primary: SplitRow; created: SplitRow[]; deletedIds: string[] }
  | { ok: false; message: string };

// ---------- 第 1 步 ----------

// R20.3 第 1 步：category 有值就用；null 跟主分类。
// 负数商品（单件折扣）没有 category 时跟上一件（上一件已经定好的分类），第一行就是负数时跟主分类
// 返回和 items 一一对应的分类 id，核对界面上每一行都能改
export function defaultItemCategories(
  items: readonly Pick<ReceiptItem, 'amountCents' | 'categoryId'>[],
  mainCategoryId: string,
): string[] {
  const result: string[] = [];
  items.forEach((item, index) => {
    if (item.categoryId !== null) {
      result.push(item.categoryId);
    } else if ((item.amountCents ?? 0) < 0 && index > 0) {
      result.push(result[index - 1]);
    } else {
      result.push(mainCategoryId);
    }
  });
  return result;
}

// ---------- 第 2、3 步 ----------

// R20.3 第 2 步：按分类合计，顺序是分类第一次出现的顺序
function groupByCategory(
  amounts: readonly number[],
  categoryIds: readonly string[],
): ReceiptGroup[] {
  const groups: ReceiptGroup[] = [];
  amounts.forEach((amountCents, index) => {
    const categoryId = categoryIds[index];
    const group = groups.find((g) => g.categoryId === categoryId);
    if (group) group.amountCents += amountCents;
    else groups.push({ categoryId, amountCents });
  });
  return groups;
}

// 最大的一组：一样大时主分类优先，再按出现顺序（数组顺序）
function largestIndex(groups: readonly ReceiptGroup[], preferredCategoryId: string): number {
  let best = 0;
  groups.forEach((g, index) => {
    const b = groups[best];
    if (g.amountCents > b.amountCents) best = index;
    else if (
      g.amountCents === b.amountCents &&
      g.categoryId === preferredCategoryId &&
      b.categoryId !== preferredCategoryId
    ) {
      best = index;
    }
  });
  return best;
}

// R20.3 第 3 步：整单折扣按比例分摊。D = 总折扣（取绝对值），S = 商品合计
// 每组先扣 floor(D × g / S)，余下的几分都从最大的一组扣
// groups 的金额必须都 > 0（planReceiptSplits 先检查），返回扣完以后的组，顺序不变
export function allocateDiscount(
  groups: readonly ReceiptGroup[],
  discountCents: number,
  mainCategoryId: string,
): ReceiptGroup[] {
  const d = Math.abs(discountCents);
  if (d === 0 || groups.length === 0) return groups.map((g) => ({ ...g }));

  const s = groups.reduce((sum, g) => sum + g.amountCents, 0);
  // 整数除法，不经过浮点数
  const shares = groups.map((g) => {
    const n = d * g.amountCents;
    return (n - (n % s)) / s;
  });
  const remainder = d - shares.reduce((sum, x) => sum + x, 0);
  shares[largestIndex(groups, mainCategoryId)] += remainder;

  return groups.map((g, index) => ({ ...g, amountCents: g.amountCents - shares[index] }));
}

// ---------- 全部步骤 ----------

function fail(message: string): ReceiptSplitPlan {
  return { ok: false, message };
}

function categoryLabel(categories: readonly Category[], id: string): string {
  const c = categories.find((x) => x.id === id);
  if (!c) throw new Error(`分类不存在: ${id}`);
  const parent = c.parentId ? categories.find((x) => x.id === c.parentId) : undefined;
  return parent ? `${parent.nameEn} / ${c.nameEn}` : c.nameEn;
}

function findCategory(categories: readonly Category[], id: string): Category {
  const c = categories.find((x) => x.id === id);
  if (!c) throw new Error(`分类不存在: ${id}`);
  return c;
}

// R20.3：receipt 必须已经通过 checkReceipt（R20.2），itemCategories 和 receipt.items 一一对应
// （defaultItemCategories 的结果，或用户在核对界面改过的）
// tx 是要挂上的交易，主分类 = 当前主拆分的分类
export function planReceiptSplits(
  receipt: NormalizedReceipt,
  itemCategories: readonly string[],
  tx: SplitTx,
  ctx: MemberContext,
): ReceiptSplitPlan {
  if (!checkReceipt(receipt).ok) throw new Error('小票没通过 checkReceipt（R20.2），不能拆分');
  if (itemCategories.length !== receipt.items.length) {
    throw new Error(`商品分类数 ${itemCategories.length} 和商品数 ${receipt.items.length} 不一致`);
  }
  if (tx.amountCents >= 0) return fail('小票只能挂在支出上');

  const primaries = tx.splits.filter((s) => s.isPrimary);
  if (primaries.length !== 1) {
    throw new Error(`交易必须恰好有一个主拆分，现在有 ${primaries.length} 个`);
  }
  const original = primaries[0];
  const mainCategoryId = original.categoryId;

  // checkReceipt 通过后金额都不为 null
  const amounts = receipt.items.map((i) => i.amountCents as number);
  const totalCents = receipt.totalCents as number;
  const discountCents = receipt.discounts.reduce((s, d) => s + (d.amountCents as number), 0);

  // 第 4 步先算差额：< 0 直接报错
  const extraCents = Math.abs(tx.amountCents) - totalCents;
  if (extraCents < 0) {
    return fail(`小票合计比这笔交易多 ${formatAud(-extraCents)}，不支持`);
  }

  // 第 2 步
  const itemGroups = groupByCategory(amounts, itemCategories);

  // 第 5 步：分摊前就 ≤ 0 的组（单件折扣比商品还大），分摊没法算，直接报错
  const notPositive = (groups: readonly ReceiptGroup[]) => groups.find((g) => g.amountCents <= 0);
  const badBefore = notPositive(itemGroups);
  if (badBefore) return failGroup(badBefore);

  // 第 3 步
  const groups = allocateDiscount(itemGroups, discountCents, mainCategoryId);

  // 第 5 步：分摊以后某组 ≤ 0
  const badAfter = notPositive(groups);
  if (badAfter) return failGroup(badAfter);

  // 第 4 步：差额 > 0 单独一组未分类（system），已经有未分类的一组就合进去
  const uncategorizedId = bySystemKey(ctx.categories, 'uncategorized').id;
  let extraGroupId: string | null = null;
  if (extraCents > 0) {
    const existing = groups.find((g) => g.categoryId === uncategorizedId);
    if (existing) existing.amountCents += extraCents;
    else groups.push({ categoryId: uncategorizedId, amountCents: extraCents });
    extraGroupId = uncategorizedId;
  }

  // 第 6 步：和主分类相同的那组当主拆分；没有就取最大的一组（一样大取先出现的）
  let primaryIndex = groups.findIndex((g) => g.categoryId === mainCategoryId);
  if (primaryIndex === -1) primaryIndex = largestIndex(groups, mainCategoryId);

  // 第 7 步：金额按交易符号（支出是负数）
  const sign = Math.sign(tx.amountCents);
  const primaryGroup = groups[primaryIndex];
  const primary = updatePrimary(original, primaryGroup, sign, tx, ctx);

  const created = groups
    .filter((_, index) => index !== primaryIndex)
    .map((g): SplitRow => {
      const category = findCategory(ctx.categories, g.categoryId);
      const member = resolveMember(
        { accountId: tx.accountId, cardLast4: tx.cardLast4, categoryId: g.categoryId },
        ctx,
      );
      return {
        id: null,
        isPrimary: false,
        amountCents: sign * g.amountCents,
        categoryId: g.categoryId,
        // 用户在核对界面确认过 → manual；差额那组 → system
        categorySource: g.categoryId === extraGroupId ? 'system' : 'manual',
        memberId: member.memberId,
        memberSource: member.memberSource,
        isPreTax: category.isPreTaxDefault,
        note: null,
      };
    });

  const deletedIds = tx.splits
    .filter((s) => !s.isPrimary)
    .map((s) => {
      if (s.id === null) throw new Error('原来的拆分必须有 id');
      return s.id;
    });

  // 第 8 步（R15.1）：合计必须等于交易金额。前面算对了不会走到这里
  const sum = primary.amountCents + created.reduce((s, x) => s + x.amountCents, 0);
  if (sum !== tx.amountCents) {
    throw new Error(`拆分合计 ${sum} 不等于交易金额 ${tx.amountCents}`);
  }

  return { ok: true, primary, created, deletedIds };

  function failGroup(g: ReceiptGroup): ReceiptSplitPlan {
    return fail(
      `${categoryLabel(ctx.categories, g.categoryId)} 合计不是正数，检查折扣跟在哪件商品后面`,
    );
  }
}

// 第 7 步主拆分：更新原来那行（id 不变），备注保留
// 分类没变 → category_source、归属人、is_pre_tax 都不变；
// 分类变了 → manual，归属人按 R5.1（manual 的不动），is_pre_tax 按新分类默认（同 R16.4）
function updatePrimary(
  original: SplitRow,
  group: ReceiptGroup,
  sign: number,
  tx: SplitTx,
  ctx: MemberContext,
): SplitRow {
  const amountCents = sign * group.amountCents;
  if (group.categoryId === original.categoryId) return { ...original, amountCents };

  const category = findCategory(ctx.categories, group.categoryId);
  const member = recomputeMember(
    {
      memberId: original.memberId,
      memberSource: original.memberSource,
      accountId: tx.accountId,
      cardLast4: tx.cardLast4,
    },
    group.categoryId,
    ctx,
  );
  return {
    ...original,
    amountCents,
    categoryId: group.categoryId,
    categorySource: 'manual',
    memberId: member.memberId,
    memberSource: member.memberSource,
    isPreTax: category.isPreTaxDefault,
  };
}
