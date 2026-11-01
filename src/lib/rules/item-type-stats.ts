// R21.7：小票商品类型按月统计
// 纯函数，不 import 数据库和 Next.js

import { ITEM_TYPES, type ItemType } from './item-type';
import { allocateDiscount, type ReceiptGroup } from './receipt-split';

// untyped = M7.6 以前存的旧小票里没有 type 的件（R21.6），和 other 分开
export type ItemTypeKey = ItemType | 'untyped';

// 一张存着的小票：receipt_date + parsed_json 里统计要用的部分
export type ItemTypeStatsReceipt = {
  receiptDate: string; // YYYY-MM-DD
  transactionId: string | null;
  parsedJson: {
    items: readonly { name: string; amountCents: number; type?: ItemType }[];
    discounts: readonly { amountCents: number }[];
  };
};

export type ItemTypeTotal = { type: ItemTypeKey; amountCents: number };
// totals 按 R21.1 的顺序，untyped 最后；合计为 0 的类型不输出
export type ItemTypeMonth = { month: string; totals: ItemTypeTotal[] };

const ORDER: readonly ItemTypeKey[] = [...ITEM_TYPES.map((t) => t.key), 'untyped'];

// R21.7 第 1、2 步：一张小票按类型合计（小票方向，正数），整单折扣按比例分摊
// 分摊复用 R20.3 第 3 步的 allocateDiscount，类型 key 当组 id；
// 类型没有主分类，传一个不会出现的 id，一样大时就按出现顺序取第一个
function receiptTotals(receipt: ItemTypeStatsReceipt): ReceiptGroup[] {
  const groups: ReceiptGroup[] = [];
  for (const item of receipt.parsedJson.items) {
    const key: ItemTypeKey = item.type ?? 'untyped';
    const group = groups.find((g) => g.categoryId === key);
    if (group) group.amountCents += item.amountCents;
    else groups.push({ categoryId: key, amountCents: item.amountCents });
  }

  const discountCents = receipt.parsedJson.discounts.reduce((s, d) => s + d.amountCents, 0);
  if (discountCents === 0) return groups;
  const itemsCents = groups.reduce((s, g) => s + g.amountCents, 0);
  if (itemsCents <= 0) throw new Error(`小票商品合计 ${itemsCents} 不是正数，整单折扣没法分摊`);
  return allocateDiscount(groups, discountCents, '');
}

// R21.7：只算挂上了交易的小票，按 receipt_date 的月份，全家。月份从早到晚
export function sumByItemType(receipts: readonly ItemTypeStatsReceipt[]): ItemTypeMonth[] {
  const byMonth = new Map<string, Map<ItemTypeKey, number>>();
  for (const receipt of receipts) {
    if (receipt.transactionId === null) continue;
    const month = receipt.receiptDate.slice(0, 7);
    let totals = byMonth.get(month);
    if (!totals) byMonth.set(month, (totals = new Map()));
    for (const g of receiptTotals(receipt)) {
      const key = g.categoryId as ItemTypeKey;
      totals.set(key, (totals.get(key) ?? 0) + g.amountCents);
    }
  }

  return [...byMonth.keys()].sort().map((month) => {
    const totals = byMonth.get(month) as Map<ItemTypeKey, number>;
    return {
      month,
      totals: ORDER.filter((type) => (totals.get(type) ?? 0) !== 0).map((type) => ({
        type,
        amountCents: totals.get(type) as number,
      })),
    };
  });
}
