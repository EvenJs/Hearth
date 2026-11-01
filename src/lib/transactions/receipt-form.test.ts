import { describe, expect, it } from 'vitest';
import { readReceiptFixture } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import type { ItemType, LearnedItemTypes } from '@/lib/rules/item-type';
import {
  normalizeReceipt,
  rawReceiptSchema,
  type ReceiptCategoryOption,
} from '@/lib/rules/receipt';
import {
  centsToReceiptInput,
  draftToForm,
  formToRaw,
  groupCategories,
  itemCategoryHints,
  itemTypeValues,
  liveCheck,
  type ReceiptItemValue,
} from './receipt-form';

// 核对界面的表单（M6.7-7）。期望值来自 business-rules.md R20.2、R20.3 第 1 步和 fixtures/README.md "小票用例"

const h = buildTestHousehold();
const TODAY = '2026-10-29';
const CATEGORIES: ReceiptCategoryOption[] = h.categories
  .filter((c) => c.parentId !== null && c.kind === 'expense')
  .map((c) => ({ id: c.id, label: c.id.slice('category:'.length) }));
let n = 0;
const key = () => `k${++n}`;

function normalized(name: `${string}.json`) {
  return normalizeReceipt(rawReceiptSchema.parse(readReceiptFixture(name)), CATEGORIES, TODAY);
}

describe('centsToReceiptInput', () => {
  it('signed, two decimals, integer maths', () => {
    expect(centsToReceiptInput(450)).toBe('4.50');
    expect(centsToReceiptInput(-80)).toBe('-0.80');
    expect(centsToReceiptInput(5)).toBe('0.05');
    expect(centsToReceiptInput(-1234)).toBe('-12.34');
    expect(centsToReceiptInput(null)).toBe('');
  });
});

describe('draftToForm / formToRaw', () => {
  it('R20.2: coles-a round-trips: normalize → form → raw → normalize gives the same receipt', () => {
    const first = normalized('coles-a.json').receipt;
    const form = draftToForm(first, key);
    expect(form).toMatchObject({
      merchant: 'COLES',
      date: '2026-08-31',
      total: '58.40',
      payment: 'card',
      cardLast4: '1111',
    });
    expect(form.items[3]).toMatchObject({
      name: 'KIWIFRUIT 4 FOR $6',
      amount: '-0.80',
      categoryId: null,
      type: null,
    });

    const raw = formToRaw(form, CATEGORIES);
    expect(raw.date).toBe('31/08/2026');
    expect(raw.items[4].category).toBe('Home & utilities / Household supplies');
    expect(normalizeReceipt(raw, CATEGORIES, TODAY)).toEqual({
      receipt: first,
      errors: { items: {}, discounts: {} },
    });
  });

  it('R20.2: grocer-b keeps the whole-receipt discount in discounts', () => {
    const form = draftToForm(normalized('grocer-b.json').receipt, key);
    expect(form.discounts).toEqual([
      expect.objectContaining({ label: 'DISCOUNT', amount: '-1.00' }),
    ]);
    expect(formToRaw(form, CATEGORIES).discounts).toEqual([{ label: 'DISCOUNT', amount: '-1.00' }]);
  });

  it('empty date → null; a category no longer in the list → null', () => {
    const form = draftToForm(normalized('coles-a.json').receipt, key);
    const raw = formToRaw(
      { ...form, date: '', items: [{ ...form.items[0], categoryId: 'category:gone' }] },
      CATEGORIES,
    );
    expect(raw.date).toBeNull();
    expect(raw.items[0].category).toBeNull();
  });

  it('every row gets its own key', () => {
    const form = draftToForm(normalized('coles-a.json').receipt, key);
    expect(new Set(form.items.map((i) => i.key)).size).toBe(9);
  });
});

describe('liveCheck（R20.2）', () => {
  it('R-A: coles-a as filled in by hand → sums match, can save', () => {
    const form = draftToForm(normalized('coles-a.json').receipt, key);
    const r = liveCheck(form, CATEGORIES, TODAY);
    expect(r.check).toEqual({ ok: true });
    expect(r.itemsCents).toBe(5840);
    expect(r.diffCents).toBe(0);
  });

  it('R20.2: MILK 4.50 → 3.50 → "差 $1.00", cannot save', () => {
    const form = draftToForm(normalized('coles-a.json').receipt, key);
    form.items[0] = { ...form.items[0], amount: '3.50' };
    const r = liveCheck(form, CATEGORIES, TODAY);
    expect(r.diffCents).toBe(100);
    expect(r.check.ok).toBe(false);
    if (r.check.ok) return;
    expect(r.check.issues).toContainEqual({
      code: 'sum_mismatch',
      diffCents: 100,
      message: '差 $1.00',
    });
  });

  it('R20.2: amount typed as "$4.50" or "-$0.80" is fine; "abc" is flagged on that row', () => {
    const form = draftToForm(normalized('coles-a.json').receipt, key);
    form.items[0] = { ...form.items[0], amount: '$4.50' };
    form.items[3] = { ...form.items[3], amount: '-$0.80' };
    expect(liveCheck(form, CATEGORIES, TODAY).check).toEqual({ ok: true });

    form.items[1] = { ...form.items[1], amount: 'abc' };
    const r = liveCheck(form, CATEGORIES, TODAY);
    expect(r.errors.items[1]).toBeTruthy();
    expect(r.diffCents).toBeNull();
  });

  it('R20.2: discounts count towards the sum (grocer-b)', () => {
    const r = liveCheck(draftToForm(normalized('grocer-b.json').receipt, key), CATEGORIES, TODAY);
    expect(r.itemsCents).toBe(3333);
    expect(r.discountsCents).toBe(-100);
    expect(r.diffCents).toBe(0);
    expect(r.check).toEqual({ ok: true });
  });
});

describe('itemCategoryHints（R20.3 第 1 步）', () => {
  it('R20.3: null → follows main; a negative null after an item → follows previous; set → set', () => {
    const items = draftToForm(normalized('coles-a.json').receipt, key).items;
    expect(itemCategoryHints(items)).toEqual([
      'main',
      'main',
      'main',
      'previous',
      'set',
      'set',
      'set',
      'main',
      'main',
    ]);
  });

  it('R20.3: a negative first row follows main', () => {
    expect(
      itemCategoryHints([
        { key: 'a', name: 'X', amount: '-1.00', categoryId: null, type: null },
        { key: 'b', name: 'Y', amount: '2.00', categoryId: null, type: null },
      ]),
    ).toEqual(['main', 'main']);
  });
});

describe('groupCategories（分类下拉）', () => {
  it('the same top in several runs becomes one group (unique keys), first-seen order kept', () => {
    const groups = groupCategories([
      { id: 'a', label: 'Entertainment & eat-out / Restaurants' },
      { id: 'b', label: 'Groceries / Supermarket' },
      { id: 'c', label: 'Entertainment & eat-out / Bubble tea' },
      { id: 'd', label: 'Groceries / Asian grocery' },
    ]);
    expect(groups).toEqual([
      {
        top: 'Entertainment & eat-out',
        items: [
          { id: 'a', name: 'Restaurants' },
          { id: 'c', name: 'Bubble tea' },
        ],
      },
      {
        top: 'Groceries',
        items: [
          { id: 'b', name: 'Supermarket' },
          { id: 'd', name: 'Asian grocery' },
        ],
      },
    ]);
  });

  it('the test household: every top appears once and no category is lost', () => {
    const groups = groupCategories(CATEGORIES);
    const tops = groups.map((g) => g.top);
    expect(new Set(tops).size).toBe(tops.length);
    expect(groups.flatMap((g) => g.items.map((i) => i.id)).sort()).toEqual(
      CATEGORIES.map((c) => c.id).sort(),
    );
  });
});

describe('itemTypeValues（R21.3、R21.4，核对界面的类型）', () => {
  const EMPTY: LearnedItemTypes = new Map();
  const row = (name: string, amount: string, type: ItemType | null = null): ReceiptItemValue => ({
    key: key(),
    name,
    amount,
    categoryId: null,
    type,
  });

  it('R21.4 T-2: coles-a untouched → same types as assignItemTypes, -0.80 follows KIWIFRUIT GOLD', () => {
    const items = draftToForm(normalized('coles-a.json').receipt, key).items;
    expect(itemTypeValues(items, EMPTY).map((v, i) => [items[i].name, v.type, v.source])).toEqual([
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

  it('R21.3: a row added by hand is recognised by its name once filled in; empty name → other', () => {
    expect(itemTypeValues([row('', '')], EMPTY)).toEqual([{ type: 'other', source: 'default' }]);
    expect(itemTypeValues([row('BANANA 1KG', '3.00')], EMPTY)).toEqual([
      { type: 'fruit', source: 'preset' },
    ]);
  });

  it('R21.3 L-2: a learned name wins over the preset', () => {
    const learned: LearnedItemTypes = new Map([['CHICKEN STOCK', 'pantry']]);
    expect(itemTypeValues([row(' chicken  stock ', '4.00')], learned)).toEqual([
      { type: 'pantry', source: 'learned' },
    ]);
  });

  it('a type picked by hand stays when the name changes', () => {
    expect(itemTypeValues([row('BANANA 1KG', '3.00', 'snack')], EMPTY)).toEqual([
      { type: 'snack', source: 'manual' },
    ]);
  });

  it('R21.4: negatives follow the item before them, including one picked by hand; a first-line negative is other', () => {
    const items = [
      row('PROMO', '-1.00', 'meat'),
      row('BANANA 1KG', '3.00', 'snack'),
      row('MEMBER SAVE', '-0.50'),
      row('ONLINE SAVE', '$-0.20', 'meat'),
      row('LETTUCE', '2.50'),
    ];
    expect(itemTypeValues(items, EMPTY)).toEqual([
      { type: 'other', source: 'default' },
      { type: 'snack', source: 'manual' },
      { type: 'snack', source: 'follow' },
      { type: 'snack', source: 'follow' },
      { type: 'vegetable', source: 'preset' },
    ]);
  });
});
