import { describe, expect, it } from 'vitest';
import { readReceiptFixture } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import {
  checkReceipt,
  normalizeReceipt,
  rawReceiptSchema,
  type NormalizedReceipt,
  type RawReceipt,
  type ReceiptCategoryOption,
} from './receipt';

// 期望值来自 business-rules.md R20.1、R20.2、R20.8 和 fixtures/README.md "小票用例"

const h = buildTestHousehold();
const TODAY = '2026-10-29';

// 支出的二级分类，label 和发给 reader 的一样：`一级 / 二级`（R20.1a）
// 测试家庭的二级分类 id 就是 `category:一级 / 二级`
const CATEGORIES: ReceiptCategoryOption[] = h.categories
  .filter((c) => c.parentId !== null && c.kind === 'expense')
  .map((c) => ({ id: c.id, label: c.id.slice('category:'.length) }));
const cat = (path: string) => h.category(path).id;

function fixture(name: `${string}.json`): RawReceipt {
  return rawReceiptSchema.parse(readReceiptFixture(name));
}

function normalizeFixture(name: `${string}.json`) {
  return normalizeReceipt(fixture(name), CATEGORIES, TODAY);
}

// 测试里手搭的原始结果，默认能通过校验
function raw(over: Partial<RawReceipt> = {}): RawReceipt {
  return {
    merchant: 'TEST MART',
    date: '24/10/2026',
    total: '10.00',
    items: [{ name: 'ITEM A', amount: '10.00', category: null }],
    discounts: [],
    payment: { method: 'unknown', cardLast4: null },
    ...over,
  };
}

// 整理好的小票，默认能通过校验
function receipt(over: Partial<NormalizedReceipt> = {}): NormalizedReceipt {
  return {
    merchant: 'TEST MART',
    date: '2026-10-24',
    totalCents: 1000,
    items: [{ name: 'ITEM A', amountCents: 1000, categoryId: null }],
    discounts: [],
    payment: { method: 'unknown', cardLast4: null },
    ...over,
  };
}

const codes = (r: NormalizedReceipt) => {
  const result = checkReceipt(r);
  return result.ok ? [] : result.issues.map((i) => i.code);
};

// ---------- R20.1 原始结果 ----------

describe('R20.1 rawReceiptSchema', () => {
  it('R20.1: extra fields (customer, cashier, barcode, card number) are dropped', () => {
    const parsed = fixture('noisy.json') as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['date', 'discounts', 'items', 'merchant', 'payment', 'total'].sort(),
    );
    expect(parsed).not.toHaveProperty('customer');
    expect(parsed).not.toHaveProperty('cashier');
    const r = parsed as RawReceipt;
    expect(Object.keys(r.items[0]).sort()).toEqual(['amount', 'category', 'name']);
    expect(r.payment).toEqual({ method: 'card', cardLast4: '1111' });
  });

  it('R20.1: all fixtures pass the schema', () => {
    for (const name of [
      'coles-a.json',
      'grocer-b.json',
      'bad-total.json',
      'coles-e.json',
      'noisy.json',
    ] as const) {
      expect(rawReceiptSchema.safeParse(readReceiptFixture(name)).success, name).toBe(true);
    }
  });

  it('R20.1: cardLast4 that is not 4 digits becomes null instead of failing', () => {
    for (const cardLast4 of ['866', '08 66', '12345', 'abcd', 1111, undefined]) {
      const parsed = rawReceiptSchema.parse({
        ...raw(),
        payment: { method: 'card', cardLast4 },
      });
      expect(parsed.payment, String(cardLast4)).toEqual({ method: 'card', cardLast4: null });
    }
  });

  it('R20.1: wrong shape fails (treated as reader failure)', () => {
    const base = raw();
    const bad: unknown[] = [
      { ...base, items: undefined },
      { ...base, total: 10 },
      { ...base, items: [{ name: 'A', amount: 10, category: null }] },
      { ...base, payment: { method: 'bitcoin', cardLast4: null } },
      { ...base, discounts: undefined },
      null,
      'not a receipt',
    ];
    for (const value of bad) {
      expect(rawReceiptSchema.safeParse(value).success).toBe(false);
    }
  });
});

// ---------- R20.2 整理 ----------

describe('R20.2 normalizeReceipt: fixtures', () => {
  it('R-A coles-a: 9 items, -$0.80 is -80 cents, categories mapped to ids, check passes', () => {
    const { receipt: r, errors } = normalizeFixture('coles-a.json');
    expect(errors).toEqual({ items: {}, discounts: {} });
    expect(r.merchant).toBe('COLES');
    expect(r.date).toBe('2026-08-31');
    expect(r.totalCents).toBe(5840);
    expect(r.items).toHaveLength(9);
    expect(r.items.map((i) => i.amountCents)).toEqual([
      450, 320, 680, -80, 600, 900, 1200, 470, 1300,
    ]);
    expect(r.items[3]).toEqual({ name: 'KIWIFRUIT 4 FOR $6', amountCents: -80, categoryId: null });
    expect(r.items[4].categoryId).toBe(cat('Home & utilities / Household supplies'));
    expect(r.items[6].categoryId).toBe(cat('Personal & medical / Cosmetics & toiletries'));
    expect(r.items.filter((i) => i.categoryId === null)).toHaveLength(6);
    expect(r.items.reduce((s, i) => s + (i.amountCents ?? 0), 0)).toBe(5840);
    expect(r.payment).toEqual({ method: 'card', cardLast4: '1111' });
    expect(checkReceipt(r)).toEqual({ ok: true });
  });

  it('R-B grocer-b: whole-receipt discount is -100 cents, check passes', () => {
    const { receipt: r, errors } = normalizeFixture('grocer-b.json');
    expect(errors).toEqual({ items: {}, discounts: {} });
    expect(r.discounts).toEqual([{ label: 'DISCOUNT', amountCents: -100 }]);
    expect(r.items.map((i) => i.amountCents)).toEqual([2000, 1000, 333]);
    expect(r.totalCents).toBe(3233);
    expect(r.payment).toEqual({ method: 'card', cardLast4: null });
    expect(checkReceipt(r)).toEqual({ ok: true });
  });

  it('R-D bad-total: check fails, off by 100 cents ("差 $1.00")', () => {
    const { receipt: r, errors } = normalizeFixture('bad-total.json');
    expect(errors).toEqual({ items: {}, discounts: {} });
    const result = checkReceipt(r);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([{ code: 'sum_mismatch', diffCents: 100, message: '差 $1.00' }]);
  });

  it('R-E coles-e: all categories null, check passes', () => {
    const { receipt: r } = normalizeFixture('coles-e.json');
    expect(r.date).toBe('2026-09-28');
    expect(r.totalCents).toBe(2345);
    expect(r.items.every((i) => i.categoryId === null)).toBe(true);
    expect(r.payment.cardLast4).toBe('2222');
    expect(checkReceipt(r)).toEqual({ ok: true });
  });

  it('R20.2 noisy: names trimmed, 12345678 masked to ****5678, unknown category becomes null', () => {
    const { receipt: r, errors } = normalizeFixture('noisy.json');
    expect(errors).toEqual({ items: {}, discounts: {} });
    expect(r.merchant).toBe('NOISY MART');
    expect(r.items[0].name).toBe('GIFT CARD ****5678');
    expect(r.items[1]).toEqual({ name: 'WHITE BREAD', amountCents: 400, categoryId: null });
    expect(checkReceipt(r)).toEqual({ ok: true });
  });

  it('R20.1/R2.3: normalized results have no 8+ digit runs and no card field except payment.cardLast4', () => {
    for (const name of [
      'coles-a.json',
      'grocer-b.json',
      'bad-total.json',
      'coles-e.json',
      'noisy.json',
    ] as const) {
      const { receipt: r } = normalizeFixture(name);
      expect(JSON.stringify(r), name).not.toMatch(/\d{8,}/);

      const cardPaths: string[] = [];
      const walk = (value: unknown, path: string) => {
        if (value === null || typeof value !== 'object') return;
        for (const [k, v] of Object.entries(value)) {
          const p = path ? `${path}.${k}` : k;
          if (/card/i.test(k)) cardPaths.push(p);
          walk(v, p);
        }
      };
      walk(r, '');
      expect(cardPaths, name).toEqual(['payment.cardLast4']);
    }
  });
});

describe('R20.2 normalizeReceipt: amounts', () => {
  it('R20.2: amount strings become integer cents', () => {
    const cases: [string, number][] = [
      ['4.50', 450],
      ['$4.50', 450],
      [' $ 12.00 ', 1200],
      ['4.5', 450],
      ['7', 700],
      ['-$0.80', -80],
      ['$-0.80', -80],
      ['-0.80', -80],
      ['- $0.80', -80],
      ['0.00', 0], // 0 由 checkReceipt 报
    ];
    for (const [amount, cents] of cases) {
      const { receipt: r, errors } = normalizeReceipt(
        raw({ items: [{ name: 'X', amount, category: null }] }),
        CATEGORIES,
        TODAY,
      );
      expect(r.items[0].amountCents, amount).toBe(cents);
      expect(errors.items, amount).toEqual({});
    }
  });

  it('R20.2: bad amount is reported on its own row and left null', () => {
    for (const amount of ['abc', '', '1,234.00', '-$-0.80', '$$1.00', '1.234', '$1.2.3']) {
      const { receipt: r, errors } = normalizeReceipt(
        raw({
          items: [
            { name: 'OK', amount: '1.00', category: null },
            { name: 'BAD', amount, category: null },
          ],
        }),
        CATEGORIES,
        TODAY,
      );
      expect(r.items[0].amountCents, amount).toBe(100);
      expect(r.items[1].amountCents, amount).toBeNull();
      expect(Object.keys(errors.items), amount).toEqual(['1']);
      expect(errors.items[1], amount).toMatch(/金额/);
    }
  });

  it('R20.2: bad total and bad discount are reported separately', () => {
    const { receipt: r, errors } = normalizeReceipt(
      raw({ total: 'TEN', discounts: [{ label: 'DISCOUNT', amount: 'x' }] }),
      CATEGORIES,
      TODAY,
    );
    expect(r.totalCents).toBeNull();
    expect(r.discounts[0].amountCents).toBeNull();
    expect(errors.total).toMatch(/总额/);
    expect(Object.keys(errors.discounts)).toEqual(['0']);
    expect(errors.items).toEqual({});
  });
});

describe('R20.2 normalizeReceipt: dates', () => {
  const dateOf = (date: string | null) => normalizeReceipt(raw({ date }), CATEGORIES, TODAY);

  it('R20.2: DD/MM/YYYY and DD/MM/YY (20YY) become YYYY-MM-DD', () => {
    expect(dateOf('24/10/26').receipt.date).toBe('2026-10-24');
    expect(dateOf('24/10/2026').receipt.date).toBe('2026-10-24');
    expect(dateOf(' 01/02/26 ').receipt.date).toBe('2026-02-01');
    expect(dateOf('29/10/2026').receipt.date).toBe(TODAY); // 今天可以
    expect(dateOf('24/10/26').errors.date).toBeUndefined();
  });

  it('R20.2: impossible, future or unreadable dates are left empty with an error', () => {
    for (const date of ['31/02/2026', '30/10/2026', '30/10/26', '2026-10-24', '1/9/26', '', null]) {
      const { receipt: r, errors } = dateOf(date);
      expect(r.date, String(date)).toBeNull();
      expect(errors.date, String(date)).toBeTruthy();
    }
    expect(dateOf('30/10/2026').errors.date).toMatch(/今天/);
  });
});

describe('R20.2 normalizeReceipt: names and categories', () => {
  it('R20.2: names are trimmed, cut to 100 characters, then masked', () => {
    const long = 'A'.repeat(150);
    const { receipt: r } = normalizeReceipt(
      raw({
        merchant: `  ${long}  `,
        items: [{ name: `  ${'B'.repeat(95)} 1234567890`, amount: '10.00', category: null }],
        discounts: [{ label: ' MEMBER 987654321 ', amount: '-1.00' }],
        total: '9.00',
      }),
      CATEGORIES,
      TODAY,
    );
    expect(r.merchant).toBe('A'.repeat(100));
    // 截到 100 以后只剩 1234（不到 8 位），不用脱敏
    expect(r.items[0].name).toBe(`${'B'.repeat(95)} 1234`);
    expect(r.discounts[0].label).toBe('MEMBER ****4321');
  });

  it('R2.3: digits that survive the cut are still masked', () => {
    const { receipt: r } = normalizeReceipt(
      raw({ items: [{ name: 'GIFT 1234567890123', amount: '10.00', category: null }] }),
      CATEGORIES,
      TODAY,
    );
    expect(r.items[0].name).toBe('GIFT ****0123');
  });

  it('R20.2: category not in the list becomes null without an error', () => {
    const { receipt: r, errors } = normalizeReceipt(
      raw({
        total: '30.00',
        items: [
          { name: 'A', amount: '10.00', category: 'Home & utilities / Household supplies' },
          { name: 'B', amount: '10.00', category: 'Made Up / Category' },
          { name: 'C', amount: '10.00', category: 'Groceries' }, // 一级不在列表里
        ],
      }),
      CATEGORIES,
      TODAY,
    );
    expect(r.items.map((i) => i.categoryId)).toEqual([
      cat('Home & utilities / Household supplies'),
      null,
      null,
    ]);
    expect(errors.items).toEqual({});
  });

  it('R20.2: archived category (not passed in) becomes null', () => {
    const withoutSupplies = CATEGORIES.filter(
      (c) => c.label !== 'Home & utilities / Household supplies',
    );
    const { receipt: r } = normalizeReceipt(fixture('coles-a.json'), withoutSupplies, TODAY);
    expect(r.items[4].categoryId).toBeNull();
    expect(r.items[6].categoryId).toBe(cat('Personal & medical / Cosmetics & toiletries'));
  });
});

// ---------- R20.2 校验 ----------

describe('R20.2 checkReceipt', () => {
  it('R20.2: items plus whole-receipt discounts must equal the total exactly', () => {
    const r = receipt({
      totalCents: 900,
      items: [
        { name: 'A', amountCents: 600, categoryId: null },
        { name: 'B', amountCents: 500, categoryId: null },
        { name: 'B OFF', amountCents: -100, categoryId: null },
      ],
      discounts: [{ label: 'DISCOUNT', amountCents: -100 }],
    });
    expect(checkReceipt(r)).toEqual({ ok: true });
    expect(checkReceipt({ ...r, totalCents: 901 })).toEqual({
      ok: false,
      issues: [{ code: 'sum_mismatch', diffCents: 1, message: '差 $0.01' }],
    });
    // 商品比总额多：diffCents 是负数，显示仍是"差 $X"
    expect(checkReceipt({ ...r, totalCents: 800 })).toEqual({
      ok: false,
      issues: [{ code: 'sum_mismatch', diffCents: -100, message: '差 $1.00' }],
    });
  });

  it('R20.2: total must be > 0 (zero and refunds rejected)', () => {
    expect(codes(receipt({ totalCents: 0, items: [] }))).toContain('total_not_positive');
    expect(
      codes(
        receipt({ totalCents: -500, items: [{ name: 'A', amountCents: -500, categoryId: null }] }),
      ),
    ).toEqual(['total_not_positive']);
  });

  it('R20.2: at least one item', () => {
    // 总额 $10、没有商品时合计也对不上，两条都报
    expect(codes(receipt({ items: [] }))).toEqual(['no_items', 'sum_mismatch']);
  });

  it('R20.2: every item amount must be non-zero', () => {
    const r = receipt({
      items: [
        { name: 'A', amountCents: 1000, categoryId: null },
        { name: 'FREE', amountCents: 0, categoryId: null },
      ],
    });
    const result = checkReceipt(r);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([{ code: 'item_zero', index: 1, message: expect.any(String) }]);
  });

  it('R20.2: whole-receipt discounts must be negative', () => {
    for (const amountCents of [100, 0]) {
      const r = receipt({
        totalCents: 1000 + amountCents,
        discounts: [{ label: 'DISCOUNT', amountCents }],
      });
      const result = checkReceipt(r);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((i) => [i.code, 'index' in i ? i.index : null])).toEqual([
        ['discount_not_negative', 0],
      ]);
    }
  });

  it('R20.2: date must be filled', () => {
    expect(codes(receipt({ date: null }))).toEqual(['date_missing']);
  });

  it('R20.2: amounts that failed to parse block saving, sum is not checked', () => {
    expect(codes(receipt({ totalCents: null }))).toEqual(['total_missing']);
    expect(codes(receipt({ items: [{ name: 'A', amountCents: null, categoryId: null }] }))).toEqual(
      ['item_amount_missing'],
    );
    expect(codes(receipt({ discounts: [{ label: 'D', amountCents: null }] }))).toEqual([
      'discount_amount_missing',
    ]);
  });

  it('R20.2: all problems are reported together', () => {
    expect(
      codes(
        receipt({
          date: null,
          totalCents: 500,
          items: [{ name: 'A', amountCents: 0, categoryId: null }],
          discounts: [{ label: 'D', amountCents: 100 }],
        }),
      ),
    ).toEqual(['date_missing', 'item_zero', 'discount_not_negative', 'sum_mismatch']);
  });
});
