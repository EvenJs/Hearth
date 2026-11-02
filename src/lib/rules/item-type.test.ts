import { describe, expect, it } from 'vitest';
import { readReceiptFixture } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import {
  ITEM_TYPES,
  ITEM_TYPE_KEYWORDS,
  assignItemTypes,
  changeItemType,
  matchItemType,
  normalizeItemName,
  resolveItemTypes,
  type ItemType,
  type LearnedItemTypes,
} from './item-type';
import {
  normalizeReceipt,
  rawReceiptSchema,
  type NormalizedReceipt,
  type ReceiptCategoryOption,
} from './receipt';

// 期望值来自 docs/rules/R21-item-type.md 和 fixtures/cases/11-item-types.md T-1 ~ T-4

const h = buildTestHousehold();
const CATEGORIES: ReceiptCategoryOption[] = h.categories
  .filter((c) => c.parentId !== null && c.kind === 'expense')
  .map((c) => ({ id: c.id, label: c.id.slice('category:'.length) }));

function fixture(name: `${string}.json`): NormalizedReceipt {
  const raw = rawReceiptSchema.parse(readReceiptFixture(name));
  return normalizeReceipt(raw, CATEGORIES, '2026-10-29').receipt;
}

const EMPTY: LearnedItemTypes = new Map();
const learned = (entries: [string, ItemType][]): LearnedItemTypes => new Map(entries);

describe('R21.1 item type list', () => {
  it('R21.1: ten types in the documented order', () => {
    expect(ITEM_TYPES.map((t) => t.key)).toEqual([
      'fruit',
      'vegetable',
      'meat',
      'seafood',
      'dairy_egg',
      'pantry',
      'snack',
      'drink',
      'household',
      'other',
    ]);
  });

  it('R21.1: untyped is not a type', () => {
    expect(ITEM_TYPES.map((t) => t.key as string)).not.toContain('untyped');
  });
});

describe('R21.2 preset keywords', () => {
  it('R21.2: no keyword appears in two types', () => {
    const all = Object.values(ITEM_TYPE_KEYWORDS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('R21.2: keywords are stored uppercase and normalized', () => {
    for (const k of Object.values(ITEM_TYPE_KEYWORDS).flat()) {
      expect(k).toBe(normalizeItemName(k));
    }
  });

  it('R21.2: other has no keywords', () => {
    expect(ITEM_TYPE_KEYWORDS.other).toEqual([]);
  });
});

describe('R21.3 normalizeItemName', () => {
  it('R21.3: trims, collapses spaces, uppercases', () => {
    expect(normalizeItemName('  chicken   stock ')).toBe('CHICKEN STOCK');
  });
});

describe('R21.3 matchItemType (T-1)', () => {
  const cases: [number, string, LearnedItemTypes, ItemType, 'learned' | 'preset' | 'default'][] = [
    [1, 'BANANAS PERKG', EMPTY, 'fruit', 'preset'],
    [2, 'GIFT CARD ****5678', EMPTY, 'other', 'default'],
    [3, 'EGGPLANT', EMPTY, 'vegetable', 'preset'],
    [4, 'ICE CREAM VANILLA', EMPTY, 'snack', 'preset'],
    [5, 'PEANUT BUTTER', EMPTY, 'pantry', 'preset'],
    [6, 'APPLE JUICE', EMPTY, 'drink', 'preset'],
    [7, 'CHICKEN STOCK', EMPTY, 'meat', 'preset'],
    [8, 'CHICKEN STOCK', learned([['CHICKEN STOCK', 'pantry']]), 'pantry', 'learned'],
    [9, '  chicken   stock ', learned([['CHICKEN STOCK', 'pantry']]), 'pantry', 'learned'],
    [10, 'CHICKEN STOCK 1L', learned([['CHICKEN STOCK', 'pantry']]), 'meat', 'preset'],
    [11, 'EGGPLANT', learned([['EGGPLANT', 'other']]), 'other', 'learned'],
  ];

  it.each(cases)('R21.3 T-1 #%i: %s', (_n, name, table, type, source) => {
    expect(matchItemType(name, table)).toEqual({ type, source });
  });
});

describe('R21.4 assignItemTypes', () => {
  it('R21.4 T-2: coles-a, negative KIWIFRUIT line follows the item before it', () => {
    const r = fixture('coles-a.json');
    expect(
      assignItemTypes(r.items, EMPTY).map((a, i) => [r.items[i].name, a.type, a.source]),
    ).toEqual([
      ['MILK 3L', 'dairy_egg', 'preset'],
      ['BANANAS PERKG', 'fruit', 'preset'],
      ['KIWIFRUIT GOLD', 'fruit', 'preset'],
      ['KIWIFRUIT 4 FOR $6', 'fruit', 'follow'],
      ['PAPER TOWEL 2PK', 'household', 'preset'],
      ['DISHWASHING LIQUID', 'household', 'preset'],
      ['SHAMPOO 400ML', 'household', 'preset'],
      ['WHITE BREAD', 'pantry', 'preset'],
      ['TASTY CHEESE', 'dairy_egg', 'preset'],
    ]);
  });

  it('R21.4 T-2: an LLM category does not change the type (SHAMPOO is still household)', () => {
    const r = fixture('coles-a.json');
    const shampoo = r.items.findIndex((i) => i.name === 'SHAMPOO 400ML');
    expect(r.items[shampoo].categoryId).not.toBeNull();
    expect(assignItemTypes(r.items, EMPTY)[shampoo].type).toBe('household');
  });

  it.each([
    [
      'coles-e.json',
      [
        ['CARROTS 1KG', 'vegetable'],
        ['RICE 2KG', 'pantry'],
        ['EGGS 12PK', 'dairy_egg'],
        ['YOGHURT 1KG', 'dairy_egg'],
      ],
    ],
    [
      'grocer-b.json',
      [
        ['RICE 5KG', 'pantry'],
        ['LAUNDRY POWDER', 'household'],
        ['TOOTHPASTE', 'household'],
      ],
    ],
    [
      'noisy.json',
      [
        ['GIFT CARD ****5678', 'other'],
        ['WHITE BREAD', 'pantry'],
      ],
    ],
  ] as const)('R21.4 T-3: %s', (name, expected) => {
    const r = fixture(name);
    const types = assignItemTypes(r.items, EMPTY);
    expect(r.items.map((item, i) => [item.name, types[i].type])).toEqual(expected);
  });

  it('R21.4 T-3: noisy GIFT CARD is other from default', () => {
    const r = fixture('noisy.json');
    expect(assignItemTypes(r.items, EMPTY)[0]).toEqual({ type: 'other', source: 'default' });
  });

  it('R21.4 T-4: first-line negative is other, consecutive negatives follow the nearest positive', () => {
    const items = [
      { name: 'PROMO', amountCents: -100 },
      { name: 'BANANA 1KG', amountCents: 300 },
      { name: 'MEMBER SAVE', amountCents: -50 },
      { name: 'ONLINE SAVE', amountCents: -20 },
      { name: 'LETTUCE', amountCents: 250 },
    ];
    expect(assignItemTypes(items, EMPTY)).toEqual([
      { type: 'other', source: 'default' },
      { type: 'fruit', source: 'preset' },
      { type: 'fruit', source: 'follow' },
      { type: 'fruit', source: 'follow' },
      { type: 'vegetable', source: 'preset' },
    ]);
  });

  it('R21.4: negative lines follow a learned type, and are not matched by their own name', () => {
    const items = [
      { name: 'CHICKEN STOCK', amountCents: 400 },
      { name: 'BANANA SAVE', amountCents: -50 },
    ];
    expect(assignItemTypes(items, learned([['CHICKEN STOCK', 'pantry']]))).toEqual([
      { type: 'pantry', source: 'learned' },
      { type: 'pantry', source: 'follow' },
    ]);
  });
});

// 期望值来自 R21.4、R21.5 和 fixtures/cases/11-item-types.md L-1 ~ L-7
describe('R21.4 + R21.5 resolveItemTypes', () => {
  // 小票 X
  const X = [
    { name: 'CHICKEN STOCK', amountCents: 400 },
    { name: 'BANANA 1KG', amountCents: 300 },
  ];

  it('R21.5: nothing submitted → automatic types, nothing learned', () => {
    const r = fixture('coles-a.json');
    expect(resolveItemTypes(r.items, undefined, EMPTY)).toEqual({
      types: assignItemTypes(r.items, EMPTY).map((m) => m.type),
      learn: [],
    });
  });

  it('R21.5 L-1: only the item whose type differs from the automatic one is learned', () => {
    expect(resolveItemTypes(X, ['pantry', 'fruit'], EMPTY)).toEqual({
      types: ['pantry', 'fruit'],
      learn: [{ name: 'CHICKEN STOCK', type: 'pantry' }],
    });
  });

  it('R21.5 L-3: same as the learned type → nothing learned', () => {
    const l = learned([['CHICKEN STOCK', 'pantry']]);
    expect(resolveItemTypes(X, ['pantry', 'fruit'], l).learn).toEqual([]);
  });

  it('R21.5 L-4: changed away from a learned type (to other) → learned again', () => {
    const l = learned([['CHICKEN STOCK', 'pantry']]);
    expect(resolveItemTypes(X, ['other', 'fruit'], l)).toEqual({
      types: ['other', 'fruit'],
      learn: [{ name: 'CHICKEN STOCK', type: 'other' }],
    });
  });

  it('R21.5 L-5: same name changed twice in one receipt → both in item order (later one wins when written)', () => {
    const items = [
      { name: 'CHICKEN STOCK', amountCents: 400 },
      { name: 'CHICKEN STOCK', amountCents: 400 },
    ];
    expect(resolveItemTypes(items, ['pantry', 'snack'], EMPTY).learn).toEqual([
      { name: 'CHICKEN STOCK', type: 'pantry' },
      { name: 'CHICKEN STOCK', type: 'snack' },
    ]);
  });

  it('R21.4 L-6: coles-a, KIWIFRUIT GOLD → snack; the -0.80 follows it and is not learned', () => {
    const r = fixture('coles-a.json');
    const submitted = assignItemTypes(r.items, EMPTY).map((m) => m.type);
    const kiwi = r.items.findIndex((i) => i.name === 'KIWIFRUIT GOLD');
    submitted[kiwi] = 'snack';

    const result = resolveItemTypes(r.items, submitted, EMPTY);
    expect(result.types[kiwi]).toBe('snack');
    expect(r.items[kiwi + 1]).toMatchObject({ name: 'KIWIFRUIT 4 FOR $6', amountCents: -80 });
    expect(result.types[kiwi + 1]).toBe('snack');
    expect(result.learn).toEqual([{ name: 'KIWIFRUIT GOLD', type: 'snack' }]);
  });

  it('R21.4 L-7: the type submitted for a negative line is ignored and recalculated', () => {
    const r = fixture('coles-a.json');
    const submitted = assignItemTypes(r.items, EMPTY).map((m) => m.type);
    const kiwi = r.items.findIndex((i) => i.name === 'KIWIFRUIT GOLD');
    submitted[kiwi + 1] = 'meat';

    const result = resolveItemTypes(r.items, submitted, EMPTY);
    expect(result.types[kiwi + 1]).toBe('fruit');
    expect(result.learn).toEqual([]);
  });

  it('R21.4: a first-line negative is other whatever was submitted', () => {
    const items = [
      { name: 'PROMO', amountCents: -100 },
      { name: 'BANANA 1KG', amountCents: 300 },
    ];
    expect(resolveItemTypes(items, ['fruit', 'fruit'], EMPTY)).toEqual({
      types: ['other', 'fruit'],
      learn: [],
    });
  });
});

describe('R21.6 changeItemType（详情页改类型）', () => {
  // 存下来的小票金额都已填好；coles-a 没有 null 金额
  const saved = (amountCents: number | null): number => {
    if (amountCents === null) throw new Error('coles-a should have no null amounts');
    return amountCents;
  };
  // coles-a 存成旧小票：items 没有 type
  const old = () =>
    fixture('coles-a.json').items.map((i) => ({ name: i.name, amountCents: saved(i.amountCents) }));
  // coles-a 存成新小票：类型同 T-2
  const typed = () => {
    const items = fixture('coles-a.json').items;
    const types = assignItemTypes(items, EMPTY);
    return items.map((i, index) => ({ name: i.name, amountCents: saved(i.amountCents), type: types[index].type }));
  };
  const indexOf = (items: { name: string }[], name: string) => items.findIndex((i) => i.name === name);

  it('R21.6 D-1: old receipt → only TASTY CHEESE gets a type; no type before still counts as changed', () => {
    const items = old();
    const cheese = indexOf(items, 'TASTY CHEESE');
    const r = changeItemType(items, cheese, 'dairy_egg');
    expect(r).toEqual({
      ok: true,
      items: items.map((i, index) => (index === cheese ? { ...i, type: 'dairy_egg' } : i)),
      learn: { name: 'TASTY CHEESE', type: 'dairy_egg' },
    });
  });

  it('R21.6 D-2: KIWIFRUIT GOLD and the -0.80 right after it get fruit; the others stay without a type', () => {
    const items = old();
    const kiwi = indexOf(items, 'KIWIFRUIT GOLD');
    const r = changeItemType(items, kiwi, 'fruit');
    if (!r.ok) throw new Error('expected ok');
    expect(r.items.map((i) => ('type' in i ? i.type : undefined))).toEqual(
      items.map((_, index) => (index === kiwi || index === kiwi + 1 ? 'fruit' : undefined)),
    );
    expect(r.learn).toEqual({ name: 'KIWIFRUIT GOLD', type: 'fruit' });
  });

  it('R21.6 D-3: SHAMPOO 400ML household → other is learned; nothing else changes', () => {
    const items = typed();
    const shampoo = indexOf(items, 'SHAMPOO 400ML');
    const r = changeItemType(items, shampoo, 'other');
    expect(r).toEqual({
      ok: true,
      items: items.map((i, index) => (index === shampoo ? { ...i, type: 'other' } : i)),
      learn: { name: 'SHAMPOO 400ML', type: 'other' },
    });
  });

  it('R21.6 D-4: same type as stored → nothing learned, items unchanged', () => {
    const items = typed();
    const r = changeItemType(items, indexOf(items, 'MILK 3L'), 'dairy_egg');
    expect(r).toEqual({ ok: true, items, learn: null });
  });

  it('R21.4: several negatives in a row all follow; the next positive item is left alone', () => {
    const items = [
      { name: 'BANANA 1KG', amountCents: 300, type: 'fruit' as ItemType },
      { name: 'MEMBER SAVE', amountCents: -50, type: 'fruit' as ItemType },
      { name: 'ONLINE SAVE', amountCents: -20, type: 'fruit' as ItemType },
      { name: 'LETTUCE', amountCents: 250, type: 'vegetable' as ItemType },
    ];
    const r = changeItemType(items, 0, 'snack');
    if (!r.ok) throw new Error('expected ok');
    expect(r.items.map((i) => i.type)).toEqual(['snack', 'snack', 'snack', 'vegetable']);
  });

  it('R21.4: a negative line or an index out of range cannot be changed', () => {
    const items = typed();
    const kiwi = indexOf(items, 'KIWIFRUIT GOLD');
    expect(changeItemType(items, kiwi + 1, 'meat')).toEqual({ ok: false });
    expect(changeItemType(items, items.length, 'meat')).toEqual({ ok: false });
    expect(changeItemType(items, -1, 'meat')).toEqual({ ok: false });
  });
});
