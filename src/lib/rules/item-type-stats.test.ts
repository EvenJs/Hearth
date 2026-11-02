import { describe, expect, it } from 'vitest';
import { readReceiptFixture } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { assignItemTypes, type ItemType } from './item-type';
import {
  sumByItemType,
  type ItemTypeKey,
  type ItemTypeMonth,
  type ItemTypeStatsReceipt,
} from './item-type-stats';
import { normalizeReceipt, rawReceiptSchema, type ReceiptCategoryOption } from './receipt';

// 期望值来自 docs/rules/R21-item-type.md R21.7 和 fixtures/cases/11-item-types.md S-1 ~ S-6

const h = buildTestHousehold();
const CATEGORIES: ReceiptCategoryOption[] = h.categories
  .filter((c) => c.parentId !== null && c.kind === 'expense')
  .map((c) => ({ id: c.id, label: c.id.slice('category:'.length) }));

type StoredItem = ItemTypeStatsReceipt['parsedJson']['items'][number];

// 假小票整理后存成 parsed_json 的样子。types：'assign' = 按 assignItemTypes（学习表空，同 T-2、T-3）；
// 'none' = 旧小票，都没有 type；数组 = 按位置给，undefined 的件没有 type
function stored(
  name: `${string}.json`,
  types: 'assign' | 'none' | (ItemType | undefined)[],
  receiptDate: string,
  transactionId: string | null = 'tx',
): ItemTypeStatsReceipt {
  const raw = rawReceiptSchema.parse(readReceiptFixture(name));
  const r = normalizeReceipt(raw, CATEGORIES, '2026-10-29').receipt;
  const items = r.items.map((i) => ({ name: i.name, amountCents: i.amountCents as number }));
  return {
    receiptDate,
    transactionId,
    parsedJson: {
      items: withTypes(items, types),
      discounts: r.discounts.map((d) => ({ amountCents: d.amountCents as number })),
    },
  };
}

function withTypes(
  items: { name: string; amountCents: number }[],
  types: 'assign' | 'none' | (ItemType | undefined)[],
): StoredItem[] {
  if (types === 'none') return items;
  const list = types === 'assign' ? assignItemTypes(items, new Map()).map((m) => m.type) : types;
  if (list.length !== items.length) throw new Error('types 和商品数不一致');
  return items.map((item, index) =>
    list[index] === undefined ? item : { ...item, type: list[index] },
  );
}

// 编的小票（S-3、S-4），直接写 parsed_json
function made(
  items: [string, number, ItemType][],
  discountCents: number[],
  receiptDate = '2026-10-15',
): ItemTypeStatsReceipt {
  return {
    receiptDate,
    transactionId: 'tx',
    parsedJson: {
      items: items.map(([name, amountCents, type]) => ({ name, amountCents, type })),
      discounts: discountCents.map((amountCents) => ({ amountCents })),
    },
  };
}

// 比较时不管类型顺序
function asMap(months: ItemTypeMonth[]): Record<string, Partial<Record<ItemTypeKey, number>>> {
  return Object.fromEntries(
    months.map((m) => [m.month, Object.fromEntries(m.totals.map((t) => [t.type, t.amountCents]))]),
  );
}

function totalOf(month: ItemTypeMonth): number {
  return month.totals.reduce((s, t) => s + t.amountCents, 0);
}

describe('R21.7 sumByItemType per receipt', () => {
  it('R21.7 S-1: coles-a without discounts sums items by type', () => {
    const out = sumByItemType([stored('coles-a.json', 'assign', '2026-08-31')]);
    expect(asMap(out)).toEqual({
      '2026-08': { fruit: 920, dairy_egg: 1750, household: 2700, pantry: 470 },
    });
    expect(totalOf(out[0])).toBe(5840);
  });

  it('R21.7 S-2: grocer-b discount is allocated by ratio, remainder from the largest type', () => {
    const out = sumByItemType([stored('grocer-b.json', 'assign', '2026-09-25')]);
    expect(asMap(out)).toEqual({ '2026-09': { pantry: 1939, household: 1294 } });
    expect(totalOf(out[0])).toBe(3233);
  });

  it('R21.7 S-3: equal largest types take the remainder from the first one in item order', () => {
    const out = sumByItemType([
      made(
        [
          ['BANANA 1KG', 500, 'fruit'],
          ['BEEF MINCE 500G', 500, 'meat'],
          ['GIFT BAG', 200, 'other'],
        ],
        [-100],
      ),
    ]);
    expect(asMap(out)).toEqual({ '2026-10': { fruit: 457, meat: 459, other: 184 } });
    expect(totalOf(out[0])).toBe(1100);
  });

  it('R21.7 S-4: a negative type total is still output without error', () => {
    const out = sumByItemType([
      made(
        [
          ['PROMO', -100, 'other'],
          ['BANANA 1KG', 300, 'fruit'],
          ['MEMBER SAVE', -50, 'fruit'],
          ['ONLINE SAVE', -20, 'fruit'],
          ['LETTUCE', 250, 'vegetable'],
        ],
        [],
      ),
    ]);
    expect(asMap(out)).toEqual({ '2026-10': { other: -100, fruit: 230, vegetable: 250 } });
    expect(totalOf(out[0])).toBe(380);
  });

  it('R21.7: types with a zero total are not output', () => {
    const out = sumByItemType([
      made(
        [
          ['BANANA 1KG', 300, 'fruit'],
          ['FREE BAG', 50, 'other'],
          ['BAG REFUND', -50, 'other'],
        ],
        [],
      ),
    ]);
    expect(out).toEqual([{ month: '2026-10', totals: [{ type: 'fruit', amountCents: 300 }] }]);
  });

  it('R21.7: totals are listed in R21.1 order with untyped last', () => {
    const out = sumByItemType([stored('coles-a.json', 'assign', '2026-08-31')]);
    expect(out[0].totals.map((t) => t.type)).toEqual(['fruit', 'dairy_egg', 'pantry', 'household']);

    const mixed = sumByItemType([
      stored(
        'coles-a.json',
        [
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'dairy_egg',
        ],
        '2026-08-31',
      ),
    ]);
    expect(mixed[0].totals.map((t) => t.type)).toEqual(['dairy_egg', 'untyped']);
  });

  it('R21.7: every receipt sums to its total, typed or untyped', () => {
    const totals: Record<string, number> = {
      'coles-a.json': 5840,
      'coles-e.json': 2345,
      'grocer-b.json': 3233,
    };
    for (const [name, total] of Object.entries(totals)) {
      for (const types of ['assign', 'none'] as const) {
        const out = sumByItemType([stored(name as `${string}.json`, types, '2026-09-01')]);
        expect(totalOf(out[0])).toBe(total);
      }
    }
  });
});

describe('R21.6 R21.7 untyped items from old receipts', () => {
  it('R21.7 S-5: coles-a with no types is all untyped', () => {
    expect(asMap(sumByItemType([stored('coles-a.json', 'none', '2026-08-31')]))).toEqual({
      '2026-08': { untyped: 5840 },
    });
  });

  it('R21.7 S-5: grocer-b with no types is all untyped after the discount', () => {
    expect(asMap(sumByItemType([stored('grocer-b.json', 'none', '2026-09-25')]))).toEqual({
      '2026-09': { untyped: 3233 },
    });
  });

  it('R21.7 S-5: coles-a with only TASTY CHEESE typed', () => {
    const types = [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'dairy_egg',
    ] as const;
    expect(asMap(sumByItemType([stored('coles-a.json', [...types], '2026-08-31')]))).toEqual({
      '2026-08': { dairy_egg: 1300, untyped: 4540 },
    });
  });

  it('R21.7 S-5: coles-a with only KIWIFRUIT GOLD and the following negative line typed', () => {
    const types = [
      undefined,
      undefined,
      'fruit',
      'fruit',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ] as const;
    expect(asMap(sumByItemType([stored('coles-a.json', [...types], '2026-08-31')]))).toEqual({
      '2026-08': { fruit: 600, untyped: 5240 },
    });
  });

  it('R21.7 S-5: untyped joins the discount allocation as its own group', () => {
    expect(
      asMap(
        sumByItemType([stored('grocer-b.json', ['pantry', undefined, undefined], '2026-09-25')]),
      ),
    ).toEqual({ '2026-09': { pantry: 1939, untyped: 1294 } });
  });

  it('R21.6: untyped and other stay as two separate rows', () => {
    const out = sumByItemType([
      {
        receiptDate: '2026-10-15',
        transactionId: 'tx',
        parsedJson: {
          items: [
            { name: 'GIFT BAG', amountCents: 200, type: 'other' },
            { name: 'OLD ITEM', amountCents: 300 },
          ],
          discounts: [],
        },
      },
    ]);
    expect(asMap(out)).toEqual({ '2026-10': { other: 200, untyped: 300 } });
  });
});

describe('R21.7 months and linked receipts', () => {
  const colesA = stored('coles-a.json', 'assign', '2026-08-31', 'tx-joint-19');
  const grocerB = stored('grocer-b.json', 'assign', '2026-09-25', 'tx-grocer');

  it('R21.7 S-6: by receipt_date month, unlinked receipts are left out', () => {
    const colesE = stored('coles-e.json', 'assign', '2026-09-28', null);
    const out = sumByItemType([grocerB, colesE, colesA]);
    expect(out.map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(asMap(out)).toEqual({
      '2026-08': { fruit: 920, dairy_egg: 1750, pantry: 470, household: 2700 },
      '2026-09': { pantry: 1939, household: 1294 },
    });
  });

  it('R21.7 S-6: once coles-e is linked it adds into 2026-09', () => {
    const colesE = stored('coles-e.json', 'assign', '2026-09-28', 'tx-coles-e');
    expect(asMap(sumByItemType([colesA, grocerB, colesE]))['2026-09']).toEqual({
      vegetable: 250,
      dairy_egg: 1495,
      pantry: 2539,
      household: 1294,
    });
  });

  it('R21.7 S-6: amounts come from the receipt, not the linked transaction', () => {
    // coles-a 挂到 -59.28 的交易（R-C），差额 0.88 不进任何类型；函数只读小票，输入里没有交易金额
    const out = sumByItemType([colesA]);
    expect(totalOf(out[0])).toBe(5840);
  });

  it('R21.7: no linked receipts gives no months', () => {
    expect(sumByItemType([])).toEqual([]);
    expect(sumByItemType([stored('coles-e.json', 'assign', '2026-09-28', null)])).toEqual([]);
  });
});
