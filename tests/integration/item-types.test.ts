// M7.6-4 商品类型学习表和 parsed_json 的类型（business-rules.md R21.5、R21.6）
// 期望值来自 business-rules.md R21.5、R21.6 和 schema.md item_type_rule
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getLearnedItemTypes, learnItemTypes } from '@/server/item-types';
import { getTransactionReceipt } from '@/server/receipts';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  TEST_USER,
  type DbTestHousehold,
} from './helpers/db';
import { insertPending } from './helpers/transactions';

let t: DbTestHousehold;

function learn(target: DbTestHousehold, items: Parameters<typeof learnItemTypes>[2]) {
  return db.transaction((tx) => learnItemTypes(target.ctx, tx, items));
}

describeDb('item_type_rule（R21.5）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  it('R21.5: same name learned twice → one row, the later type wins (name_key normalized)', async () => {
    await learn(t, [{ name: 'tasty  cheese', type: 'snack' }]);
    await learn(t, [{ name: ' TASTY CHEESE ', type: 'dairy_egg' }]);

    const rows = await db.select().from(schema.itemTypeRule);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      householdId: t.ctx.householdId,
      nameKey: 'TASTY CHEESE',
      itemType: 'dairy_egg',
      createdBy: TEST_USER.id,
    });
    expect(await getLearnedItemTypes(t.ctx)).toEqual(new Map([['TASTY CHEESE', 'dairy_egg']]));
  });

  it('R21.5: same name twice in one batch → the later one wins; other is learned too', async () => {
    await learn(t, [
      { name: 'WHITE BREAD', type: 'snack' },
      { name: 'KIWIFRUIT GOLD', type: 'other' },
      { name: 'white bread', type: 'pantry' },
    ]);

    expect(await getLearnedItemTypes(t.ctx)).toEqual(
      new Map([
        ['WHITE BREAD', 'pantry'],
        ['KIWIFRUIT GOLD', 'other'],
      ]),
    );
  });

  it('R21.5: learning rolls back with the surrounding transaction', async () => {
    await expect(
      db.transaction(async (tx) => {
        await learnItemTypes(t.ctx, tx, [{ name: 'WHITE BREAD', type: 'pantry' }]);
        throw new Error('保存失败');
      }),
    ).rejects.toThrow('保存失败');

    expect(await db.$count(schema.itemTypeRule)).toBe(0);
  });

  it("R21.5: another household's learned types are invisible", async () => {
    await learn(t, [{ name: 'WHITE BREAD', type: 'pantry' }]);
    await db.delete(schema.householdUser).where(eq(schema.householdUser.userId, TEST_USER.id));
    const other = await createTestHousehold();

    expect(await getLearnedItemTypes(other.ctx)).toEqual(new Map());
    await learn(other, [{ name: 'WHITE BREAD', type: 'snack' }]);
    expect(await getLearnedItemTypes(t.ctx)).toEqual(new Map([['WHITE BREAD', 'pantry']]));
    expect(await getLearnedItemTypes(other.ctx)).toEqual(new Map([['WHITE BREAD', 'snack']]));
  });
});

describeDb('parsed_json 的 type（R21.6）', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
  });

  async function receiptOn(items: Record<string, unknown>[]) {
    const transactionId = await insertPending(t, {
      account: 'ANZ Joint',
      date: '2026-09-01',
      amountCents: -1150,
      category: 'Groceries / Supermarket',
      member: 'Home',
    });
    await db.insert(schema.receipt).values({
      householdId: t.ctx.householdId,
      transactionId,
      merchant: 'COLES',
      receiptDate: '2026-09-01',
      totalCents: 1150,
      parsedJson: { items, discounts: [], payment: 'card' },
      reader: 'manual',
      createdBy: TEST_USER.id,
    });
    return transactionId;
  }

  it('R21.6: an old receipt (items without type) still reads', async () => {
    const id = await receiptOn([
      { name: 'MILK 3L', amountCents: 450, category: null },
      { name: 'KIWIFRUIT GOLD', amountCents: 700, category: null },
    ]);

    const shown = await getTransactionReceipt(t.ctx, id);
    expect(shown!.items.map((i) => [i.name, i.amountCents])).toEqual([
      ['MILK 3L', 450],
      ['KIWIFRUIT GOLD', 700],
    ]);
  });

  it('R21.6: items with and without type mixed still read', async () => {
    const id = await receiptOn([
      { name: 'MILK 3L', amountCents: 450, category: null, type: 'dairy_egg' },
      { name: 'KIWIFRUIT GOLD', amountCents: 700, category: null },
    ]);

    expect((await getTransactionReceipt(t.ctx, id))!.items).toHaveLength(2);
  });
});
