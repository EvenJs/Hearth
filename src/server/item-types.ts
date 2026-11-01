// R21.5：商品类型学习表 item_type_rule（M7.6-4）
// 只在用户手动改了类型时写，"改没改"由调用方（小票保存、详情页改类型）判断
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { itemTypeRule } from '@/db/schema';
import { normalizeItemName, type ItemType, type LearnedItemTypes } from '@/lib/rules/item-type';
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
