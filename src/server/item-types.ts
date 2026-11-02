// R21.5：商品类型学习表 item_type_rule（M7.6-4）；R21.7：看板的商品类型统计（M7.6-7）
// 学习表只在用户手动改了类型时写，"改没改"由调用方（小票保存、详情页改类型）判断
import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { itemTypeRule, receipt } from '@/db/schema';
import {
  ITEM_TYPE_KEYS,
  normalizeItemName,
  type ItemType,
  type LearnedItemTypes,
} from '@/lib/rules/item-type';
import { sumByItemType, type ItemTypeKey } from '@/lib/rules/item-type-stats';
import type { DateRange } from '@/lib/rules/periods';
import { pivotColumns, type PivotColumn } from '@/lib/rules/stats';
import type { HouseholdContext } from './context';
import type { DbTx } from './transactions';

// R21.5：name_key → 类型。保存小票时传 tx，用事务里当时的学习表
export async function getLearnedItemTypes(
  ctx: HouseholdContext,
  q: DbTx | typeof db = db,
): Promise<LearnedItemTypes> {
  const rows = await q
    .select({ nameKey: itemTypeRule.nameKey, itemType: itemTypeRule.itemType })
    .from(itemTypeRule)
    .where(eq(itemTypeRule.householdId, ctx.householdId));
  return new Map(rows.map((r) => [r.nameKey, r.itemType]));
}

// R21.5：upsert，在调用方的事务里，保存失败就都不写
// 同名出现几次 → 按顺序后面的为准（先在内存里去重，一条 INSERT 里不能两行撞同一个冲突键）
export async function learnItemTypes(
  ctx: HouseholdContext,
  tx: DbTx,
  items: readonly { name: string; type: ItemType }[],
): Promise<void> {
  const byKey = new Map<string, ItemType>();
  for (const i of items) {
    const key = normalizeItemName(i.name);
    if (key !== '') byKey.set(key, i.type);
  }
  if (byKey.size === 0) return;

  await tx
    .insert(itemTypeRule)
    .values(
      [...byKey].map(([nameKey, itemType]) => ({
        householdId: ctx.householdId,
        nameKey,
        itemType,
        createdBy: ctx.userId,
      })),
    )
    .onConflictDoUpdate({
      target: [itemTypeRule.householdId, itemTypeRule.nameKey],
      set: {
        itemType: sql`excluded.item_type`,
        createdBy: sql`excluded.created_by`,
        updatedAt: sql`now()`,
      },
    });
}

// parsed_json 里统计要用的部分（完整形状见 receipts.ts）；旧小票没有 type（R21.8）
const statsJsonSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      amountCents: z.number().int(),
      type: z.enum(ITEM_TYPE_KEYS).optional(),
    }),
  ),
  discounts: z.array(z.object({ amountCents: z.number().int() })),
});

export type ItemTypeStatsRow = { type: ItemTypeKey; cells: number[]; total: number };
export type ItemTypeStats = {
  columns: PivotColumn[]; // 按自然月切开，首尾不满一个月的 partial
  rows: ItemTypeStatsRow[]; // R21.1 的顺序，untyped 最后；整段都没有金额的类型不输出
  columnTotals: number[];
  total: number;
};

// R21.7：看板上的商品类型统计（M7.6-7）。本家庭、挂上了交易的小票，receipt_date 落在时间段里
// 全家，不分归属人；口径都在 sumByItemType 里
export async function getItemTypeStats(
  ctx: HouseholdContext,
  range: DateRange,
): Promise<ItemTypeStats> {
  const rows = await db
    .select({
      receiptDate: receipt.receiptDate,
      transactionId: receipt.transactionId,
      parsedJson: receipt.parsedJson,
    })
    .from(receipt)
    .where(
      and(
        eq(receipt.householdId, ctx.householdId),
        isNotNull(receipt.transactionId),
        gte(receipt.receiptDate, range.start),
        lte(receipt.receiptDate, range.end),
      ),
    );
  const months = sumByItemType(
    rows.map((r) => ({ ...r, parsedJson: statsJsonSchema.parse(r.parsedJson) })),
  );

  const columns = pivotColumns(range, 'month');
  const byType = new Map<ItemTypeKey, number[]>();
  for (const m of months) {
    const i = columns.findIndex((c) => c.start.slice(0, 7) === m.month);
    for (const t of m.totals) {
      let cells = byType.get(t.type);
      if (!cells) byType.set(t.type, (cells = columns.map(() => 0)));
      cells[i] += t.amountCents;
    }
  }
  // 各月出现的类型不一样，合起来以后再按 R21.1 的顺序排，untyped 最后
  const order: readonly ItemTypeKey[] = [...ITEM_TYPE_KEYS, 'untyped'];
  const statRows = order
    .filter((type) => byType.has(type))
    .map((type) => {
      const cells = byType.get(type) as number[];
      return { type, cells, total: cells.reduce((s, c) => s + c, 0) };
    });
  const columnTotals = columns.map((_, i) => statRows.reduce((s, r) => s + r.cells[i], 0));
  return {
    columns,
    rows: statRows,
    columnTotals,
    total: columnTotals.reduce((s, c) => s + c, 0),
  };
}
