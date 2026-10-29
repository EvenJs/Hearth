import { describe, expect, it } from 'vitest';
import { readReceiptFixture } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import {
  normalizeReceipt,
  rawReceiptSchema,
  type NormalizedReceipt,
  type ReceiptCategoryOption,
  type ReceiptItem,
} from './receipt';
import {
  allocateDiscount,
  defaultItemCategories,
  planReceiptSplits,
  type ReceiptSplitPlan,
} from './receipt-split';
import type { SplitRow, SplitTx } from './split';

// 期望值来自 business-rules.md R20.3、R20.8（R-A、R-B、R-C）、R5、R15.1
// 和 fixtures/README.md "小票用例"

const h = buildTestHousehold();
const joint = h.account('ANZ Joint');
const cat = (path: string) => h.category(path).id;
const mem = (name: string) => h.member(name).id;
const UNCATEGORIZED = h.systemCategory('uncategorized').id;

const SUPERMARKET = cat('Groceries / Supermarket');
const SUPPLIES = cat('Home & utilities / Household supplies');
const COSMETICS = cat('Personal & medical / Cosmetics & toiletries');

const CATEGORIES: ReceiptCategoryOption[] = h.categories
  .filter((c) => c.parentId !== null && c.kind === 'expense')
  .map((c) => ({ id: c.id, label: c.id.slice('category:'.length) }));

const ctx = { categories: h.categories, cards: h.cards, accounts: h.accounts };

function fixture(name: `${string}.json`): NormalizedReceipt {
  const raw = rawReceiptSchema.parse(readReceiptFixture(name));
  return normalizeReceipt(raw, CATEGORIES, '2026-10-29').receipt;
}

function primarySplit(over: Partial<SplitRow> = {}): SplitRow {
  return {
    id: 'split:primary',
    isPrimary: true,
    amountCents: -5840,
    categoryId: SUPERMARKET,
    categorySource: 'rule',
    memberId: mem('Home'),
    memberSource: 'category',
    isPreTax: false,
    note: null,
    ...over,
  };
}

// joint-2026-09.csv #19：COLES -58.40，卡 1111，主拆分 Groceries / Supermarket（rule），Home（category）
function tx19(amountCents = -5840, primary: Partial<SplitRow> = {}): SplitTx {
  return {
    accountId: joint.id,
    cardLast4: '1111',
    amountCents,
    splits: [primarySplit({ amountCents, ...primary })],
  };
}

function plan(receipt: NormalizedReceipt, tx: SplitTx, itemCategories?: string[]) {
  const main = tx.splits.find((s) => s.isPrimary)!.categoryId;
  return planReceiptSplits(
    receipt,
    itemCategories ?? defaultItemCategories(receipt.items, main),
    tx,
    ctx,
  );
}

function ok(r: ReceiptSplitPlan) {
  if (!r.ok) throw new Error(r.message);
  return r;
}

// 结果拆分（主拆分在前），方便比较
function rows(r: ReceiptSplitPlan) {
  const { primary, created } = ok(r);
  return [primary, ...created].map((s) => ({
    amountCents: s.amountCents,
    categoryId: s.categoryId,
    categorySource: s.categorySource,
    memberId: s.memberId,
    memberSource: s.memberSource,
  }));
}

function total(r: ReceiptSplitPlan): number {
  const { primary, created } = ok(r);
  return [primary, ...created].reduce((s, x) => s + x.amountCents, 0);
}

function item(amountCents: number, categoryId: string | null = null, name = 'X'): ReceiptItem {
  return { name, amountCents, categoryId };
}

function receipt(items: ReceiptItem[], discounts: number[] = []): NormalizedReceipt {
  const totalCents =
    items.reduce((s, i) => s + (i.amountCents ?? 0), 0) + discounts.reduce((s, d) => s + d, 0);
  return {
    merchant: 'TEST MART',
    date: '2026-09-01',
    totalCents,
    items,
    discounts: discounts.map((amountCents) => ({ label: 'DISCOUNT', amountCents })),
    payment: { method: 'card', cardLast4: '1111' },
  };
}

// ---------- 第 1 步 ----------

describe('R20.3 step 1 defaultItemCategories', () => {
  it('R20.3: null follows the main category, a set category is kept', () => {
    expect(defaultItemCategories([item(100), item(200, SUPPLIES), item(300)], SUPERMARKET)).toEqual(
      [SUPERMARKET, SUPPLIES, SUPERMARKET],
    );
  });

  it('R20.3: a negative item (single-item discount) follows the item before it', () => {
    expect(
      defaultItemCategories(
        [item(1200, COSMETICS), item(-200), item(500), item(-100)],
        SUPERMARKET,
      ),
    ).toEqual([COSMETICS, COSMETICS, SUPERMARKET, SUPERMARKET]);
  });

  it('R20.3: consecutive negatives all follow the last positive item', () => {
    expect(
      defaultItemCategories([item(1000, SUPPLIES), item(-100), item(-50)], SUPERMARKET),
    ).toEqual([SUPPLIES, SUPPLIES, SUPPLIES]);
  });

  it('R20.3: a negative first row follows the main category', () => {
    expect(defaultItemCategories([item(-100), item(500, SUPPLIES)], SUPERMARKET)).toEqual([
      SUPERMARKET,
      SUPPLIES,
    ]);
  });

  it('R20.3: a negative item with its own category keeps it', () => {
    expect(
      defaultItemCategories([item(1000, SUPPLIES), item(-100, COSMETICS)], SUPERMARKET),
    ).toEqual([SUPPLIES, COSMETICS]);
  });

  it('R-A: coles-a items', () => {
    expect(defaultItemCategories(fixture('coles-a.json').items, SUPERMARKET)).toEqual([
      SUPERMARKET,
      SUPERMARKET,
      SUPERMARKET,
      SUPERMARKET, // KIWIFRUIT 4 FOR $6 -0.80 跟上一件
      SUPPLIES,
      SUPPLIES,
      COSMETICS,
      SUPERMARKET,
      SUPERMARKET,
    ]);
  });
});

// ---------- 第 3 步 ----------

describe('R20.3 step 3 allocateDiscount', () => {
  it('R-B: floor shares, whole-receipt discount remainder goes to the largest group', () => {
    const groups = [
      { categoryId: SUPERMARKET, amountCents: 2000 },
      { categoryId: SUPPLIES, amountCents: 1000 },
      { categoryId: COSMETICS, amountCents: 333 },
    ];
    // 60 + 1（余数）、30、9
    expect(allocateDiscount(groups, 100, SUPERMARKET)).toEqual([
      { categoryId: SUPERMARKET, amountCents: 1939 },
      { categoryId: SUPPLIES, amountCents: 970 },
      { categoryId: COSMETICS, amountCents: 324 },
    ]);
  });

  it('R20.3: largest-group tie goes to the main category first', () => {
    const groups = [
      { categoryId: SUPPLIES, amountCents: 1000 },
      { categoryId: SUPERMARKET, amountCents: 1000 },
    ];
    expect(allocateDiscount(groups, 1, SUPERMARKET)).toEqual([
      { categoryId: SUPPLIES, amountCents: 1000 },
      { categoryId: SUPERMARKET, amountCents: 999 },
    ]);
  });

  it('R20.3: largest-group tie without the main category goes to the first one', () => {
    const groups = [
      { categoryId: SUPPLIES, amountCents: 1000 },
      { categoryId: COSMETICS, amountCents: 1000 },
    ];
    expect(allocateDiscount(groups, 1, SUPERMARKET)).toEqual([
      { categoryId: SUPPLIES, amountCents: 999 },
      { categoryId: COSMETICS, amountCents: 1000 },
    ]);
  });

  it('R20.3: no discount leaves groups unchanged; result always sums to S - D', () => {
    const groups = [
      { categoryId: SUPERMARKET, amountCents: 777 },
      { categoryId: SUPPLIES, amountCents: 1234 },
      { categoryId: COSMETICS, amountCents: 1 },
    ];
    expect(allocateDiscount(groups, 0, SUPERMARKET)).toEqual(groups);
    for (const d of [1, 2, 3, 99, 500, 2011]) {
      const out = allocateDiscount(groups, d, SUPERMARKET);
      expect(
        out.reduce((s, g) => s + g.amountCents, 0),
        String(d),
      ).toBe(2012 - d);
    }
  });
});

// ---------- 全部步骤 ----------

describe('R20.3 planReceiptSplits', () => {
  it('R-A: #19 splits into -31.40 / -15.00 / -12.00, primary keeps category_source rule', () => {
    const r = plan(fixture('coles-a.json'), tx19());
    expect(rows(r)).toEqual([
      {
        amountCents: -3140,
        categoryId: SUPERMARKET,
        categorySource: 'rule',
        memberId: mem('Home'),
        memberSource: 'category',
      },
      {
        amountCents: -1500,
        categoryId: SUPPLIES,
        categorySource: 'manual',
        memberId: mem('Home'),
        memberSource: 'category',
      },
      {
        amountCents: -1200,
        categoryId: COSMETICS,
        categorySource: 'manual',
        memberId: mem('Male'),
        memberSource: 'card',
      },
    ]);
    const { primary, created, deletedIds } = ok(r);
    expect(primary.id).toBe('split:primary');
    expect(primary.isPrimary).toBe(true);
    expect(created.every((s) => s.id === null && !s.isPrimary && s.note === null)).toBe(true);
    expect(created.map((s) => s.isPreTax)).toEqual([false, false]);
    expect(deletedIds).toEqual([]);
    expect(total(r)).toBe(-5840);
  });

  it('R-B: whole-receipt discount gives -19.39 / -9.70 / -3.24', () => {
    const tx: SplitTx = { ...tx19(-3233), cardLast4: null };
    const r = plan(fixture('grocer-b.json'), tx);
    expect(rows(r).map((s) => [s.amountCents, s.categoryId])).toEqual([
      [-1939, SUPERMARKET],
      [-970, SUPPLIES],
      [-324, COSMETICS],
    ]);
    expect(total(r)).toBe(-3233);
  });

  it('R-C: transaction bigger than the receipt gets an extra Uncategorised group (system)', () => {
    const r = plan(fixture('coles-a.json'), tx19(-5928));
    expect(rows(r)).toEqual([
      expect.objectContaining({ amountCents: -3140, categoryId: SUPERMARKET }),
      expect.objectContaining({ amountCents: -1500, categoryId: SUPPLIES }),
      expect.objectContaining({ amountCents: -1200, categoryId: COSMETICS }),
      {
        amountCents: -88,
        categoryId: UNCATEGORIZED,
        categorySource: 'system',
        // 未分类没有分类默认 → 卡号 1111
        memberId: mem('Male'),
        memberSource: 'card',
      },
    ]);
    expect(total(r)).toBe(-5928);
  });

  it('R-C: receipt bigger than the transaction is rejected with the amount', () => {
    const r = planReceiptSplits(
      fixture('coles-a.json'),
      defaultItemCategories(fixture('coles-a.json').items, SUPERMARKET),
      tx19(-5000),
      ctx,
    );
    expect(r).toEqual({ ok: false, message: '小票合计比这笔交易多 $8.40，不支持' });
  });

  it('R20.3: the difference merges into an existing Uncategorised group', () => {
    const rc = fixture('coles-a.json');
    const cats = defaultItemCategories(rc.items, SUPERMARKET);
    cats[8] = UNCATEGORIZED; // TASTY CHEESE 13.00 用户改成未分类
    const r = plan(rc, tx19(-5928), cats);
    expect(rows(r).map((s) => [s.amountCents, s.categoryId, s.categorySource])).toEqual([
      [-1840, SUPERMARKET, 'rule'],
      [-1500, SUPPLIES, 'manual'],
      [-1200, COSMETICS, 'manual'],
      [-1300 - 88, UNCATEGORIZED, 'system'],
    ]);
    expect(total(r)).toBe(-5928);
  });

  it('R20.3: a single group leaves the primary split unchanged and creates nothing', () => {
    const tx: SplitTx = { ...tx19(-2345), cardLast4: null };
    const r = ok(plan(fixture('coles-e.json'), tx));
    expect(r.primary).toEqual(tx.splits[0]);
    expect(r.created).toEqual([]);
    expect(r.deletedIds).toEqual([]);
  });

  it('R20.3: main category group missing → largest group is primary, manual, member by R5.1', () => {
    const tx = tx19(-5840, {
      categoryId: UNCATEGORIZED,
      categorySource: 'system',
      memberId: mem('Male'),
      memberSource: 'card',
    });
    const r = plan(fixture('coles-a.json'), tx, [
      SUPPLIES,
      SUPPLIES,
      SUPPLIES,
      SUPPLIES,
      SUPPLIES,
      SUPPLIES,
      COSMETICS,
      SUPERMARKET,
      SUPERMARKET,
    ]);
    // Household supplies 4.50+3.20+6.80-0.80+6.00+9.00 = 28.70；Supermarket 17.70；Cosmetics 12.00
    expect(rows(r)).toEqual([
      {
        amountCents: -2870,
        categoryId: SUPPLIES,
        categorySource: 'manual',
        memberId: mem('Home'),
        memberSource: 'category',
      },
      expect.objectContaining({ amountCents: -1200, categoryId: COSMETICS }),
      expect.objectContaining({ amountCents: -1770, categoryId: SUPERMARKET }),
    ]);
    expect(ok(r).primary.id).toBe('split:primary');
    expect(total(r)).toBe(-5840);
  });

  it('R5.1: primary with member_source manual keeps its member when its category changes', () => {
    const tx = tx19(-5840, {
      categoryId: UNCATEGORIZED,
      categorySource: 'system',
      memberId: mem('Female'),
      memberSource: 'manual',
    });
    const rc = fixture('coles-a.json');
    const { primary } = ok(plan(rc, tx, defaultItemCategories(rc.items, SUPERMARKET)));
    expect(primary).toMatchObject({
      amountCents: -3140,
      categoryId: SUPERMARKET,
      categorySource: 'manual',
      memberId: mem('Female'),
      memberSource: 'manual',
    });
  });

  it('R20.3: largest-group tie for primary goes to the first group', () => {
    const tx = tx19(-2000, { categoryId: UNCATEGORIZED, categorySource: 'system' });
    const r = plan(receipt([item(1000, COSMETICS), item(1000, SUPPLIES)]), tx);
    expect(ok(r).primary.categoryId).toBe(COSMETICS);
  });

  it('R20.3: a single-item discount that makes its group ≤ 0 is rejected', () => {
    const rc = receipt([item(500, SUPPLIES, 'SPONGE'), item(-600), item(2000)]);
    const r = plan(rc, tx19(rc.totalCents! * -1));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('Household supplies');
    expect(r.message).toContain('检查折扣跟在哪件商品后面');
  });

  it('R20.3: a group equal to 0 after item discount is rejected too', () => {
    const rc = receipt([item(500, SUPPLIES), item(-500), item(2000)]);
    expect(plan(rc, tx19(-2000)).ok).toBe(false);
  });

  it('R20.3 step 7: existing non-primary splits are deleted, primary note is kept', () => {
    const tx: SplitTx = {
      ...tx19(),
      splits: [
        primarySplit({ amountCents: -5000, note: '周末采购' }),
        {
          ...primarySplit({ amountCents: -840 }),
          id: 'split:old',
          isPrimary: false,
          categoryId: COSMETICS,
          categorySource: 'manual',
        },
      ],
    };
    const r = ok(plan(fixture('coles-a.json'), tx));
    expect(r.deletedIds).toEqual(['split:old']);
    expect(r.primary.note).toBe('周末采购');
    expect(r.primary.amountCents).toBe(-3140);
    expect(r.created).toHaveLength(2);
  });

  it('R15.1: every successful plan sums to the transaction amount', () => {
    const cases: [NormalizedReceipt, number][] = [
      [fixture('coles-a.json'), -5840],
      [fixture('coles-a.json'), -6000],
      [fixture('grocer-b.json'), -3233],
      [fixture('grocer-b.json'), -3300],
      [fixture('coles-e.json'), -2345],
      [receipt([item(333, SUPPLIES), item(333, COSMETICS), item(334)], [-7]), -993],
    ];
    for (const [rc, amount] of cases) {
      const r = plan(rc, tx19(amount));
      expect(total(r), String(amount)).toBe(amount);
      expect([ok(r).primary, ...ok(r).created].every((s) => s.amountCents < 0)).toBe(true);
    }
  });

  it('R20.3: only for expenses; receipt must pass checkReceipt; one category per item', () => {
    const rc = fixture('coles-a.json');
    const cats = defaultItemCategories(rc.items, SUPERMARKET);
    expect(planReceiptSplits(rc, cats, tx19(5840), ctx)).toEqual({
      ok: false,
      message: '小票只能挂在支出上',
    });
    expect(() =>
      planReceiptSplits(fixture('bad-total.json'), [SUPERMARKET, SUPERMARKET], tx19(-3100), ctx),
    ).toThrow();
    expect(() => planReceiptSplits(rc, cats.slice(1), tx19(), ctx)).toThrow();
  });
});
