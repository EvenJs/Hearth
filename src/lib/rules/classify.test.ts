import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { readFixture } from '../../../tests/helpers/fixtures';
import { parseAnzCsv } from '../import/anz';
import { classify, matchRule } from './classify';
import { extractAndMask } from './extract';
import { cleanMerchant } from './merchant';
import type { CategoryRule } from './types';

// 期望值来自 business-rules.md R7、R7.1 和 fixtures/README.md "期望结果：joint-2026-09.csv" 分类列

const h = buildTestHousehold();

function rule(
  over: Partial<CategoryRule> & Pick<CategoryRule, 'keyword' | 'categoryId'>,
): CategoryRule {
  return {
    id: `rule:test:${over.keyword}:${over.priority ?? 0}`,
    matchType: 'contains',
    priority: 0,
    isSystem: false,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

const supermarket = h.category('Groceries / Supermarket');
const restaurants = h.category('Entertainment & eat-out / Restaurants');
const coffee = h.category('Entertainment & eat-out / Coffee & tea');

describe('classify（R7 顺序）', () => {
  it('R7 step 1: already marked as internal transfer → Internal transfer, system', () => {
    // 即使 merchant 命中用户规则，也是内部转账
    expect(
      classify(
        { merchant: 'COLES 0559 MELBOURNE', isInternalTransfer: true },
        h.rules,
        h.categories,
      ),
    ).toEqual({
      categoryId: h.systemCategory('internal_transfer').id,
      categorySource: 'system',
      isPreTax: false,
    });
  });

  it('R7 step 2: merchant starting with ATM → Cash withdrawal, system', () => {
    expect(
      classify({ merchant: 'ATM CBA HAWTHORN', isInternalTransfer: false }, h.rules, h.categories),
    ).toEqual({
      categoryId: h.systemCategory('cash_withdrawal').id,
      categorySource: 'system',
      isPreTax: false,
    });
  });

  it('R7 step 2: ATM only at the start', () => {
    const r = classify(
      { merchant: 'SHOP ATM MELBOURNE', isInternalTransfer: false },
      h.rules,
      h.categories,
    );
    expect(r.categoryId).toBe(h.systemCategory('uncategorized').id);
  });

  it('R7 step 2: contains ACCOUNT SERVICING FEE (incl. REVERSAL OF) → Bank fees, system', () => {
    for (const merchant of [
      'ACCOUNT SERVICING FEE',
      'REVERSAL OF ACCOUNT SERVICING FEE MINIMUM $2000 IN DEPOSITS RECEIVED',
    ]) {
      expect(classify({ merchant, isInternalTransfer: false }, h.rules, h.categories)).toEqual({
        categoryId: h.systemCategory('bank_fee').id,
        categorySource: 'system',
        isPreTax: false,
      });
    }
  });

  it('R7: system rules (step 2) beat user rules (step 3), whatever the priority', () => {
    const rules = [
      rule({ keyword: 'ATM', categoryId: restaurants.id, priority: 100 }),
      rule({ keyword: 'ACCOUNT SERVICING', categoryId: restaurants.id, priority: 100 }),
    ];
    expect(
      classify({ merchant: 'ATM CBA HAWTHORN', isInternalTransfer: false }, rules, h.categories)
        .categoryId,
    ).toBe(h.systemCategory('cash_withdrawal').id);
    expect(
      classify(
        { merchant: 'ACCOUNT SERVICING FEE', isInternalTransfer: false },
        rules,
        h.categories,
      ).categoryId,
    ).toBe(h.systemCategory('bank_fee').id);
  });

  it('R7 step 3: user rule match → that category, source rule', () => {
    expect(
      classify(
        { merchant: 'COLES 0559 MELBOURNE', isInternalTransfer: false },
        h.rules,
        h.categories,
      ),
    ).toEqual({ categoryId: supermarket.id, categorySource: 'rule', isPreTax: false });
  });

  it('R7 step 4: nothing matches → Uncategorised, system', () => {
    expect(
      classify(
        { merchant: 'UNKNOWN SHOP PTY LTD MELBOURNE', isInternalTransfer: false },
        h.rules,
        h.categories,
      ),
    ).toEqual({
      categoryId: h.systemCategory('uncategorized').id,
      categorySource: 'system',
      isPreTax: false,
    });
  });
});

describe('matchRule（R7 第 3 步）', () => {
  it('R7: contains and starts_with, case-insensitive', () => {
    const contains = rule({ keyword: 'grocer', categoryId: supermarket.id });
    const starts = rule({ keyword: 'KUMO', matchType: 'starts_with', categoryId: restaurants.id });
    expect(matchRule('DOWNTOWN GROCER', [contains])).toBe(contains);
    expect(matchRule('KUMO MELBOURNE', [starts])).toBe(starts);
    expect(matchRule('SUSHI KUMO', [starts])).toBeNull();
  });

  it('R7: higher priority wins over longer keyword', () => {
    const long = rule({ keyword: 'DOWNTOWN GROCER', categoryId: supermarket.id });
    const short = rule({ keyword: 'GROCER', categoryId: restaurants.id, priority: 1 });
    expect(matchRule('DOWNTOWN GROCER', [long, short])).toBe(short);
  });

  it('R7: same priority → longer keyword wins (DOWNTOWN GROCER over GROCER)', () => {
    const short = rule({ keyword: 'GROCER', categoryId: restaurants.id });
    const long = rule({ keyword: 'DOWNTOWN GROCER', categoryId: supermarket.id });
    expect(matchRule('DOWNTOWN GROCER', [short, long])).toBe(long);
  });

  it('R7: same priority and length → earlier createdAt wins', () => {
    const later = rule({
      keyword: 'GROCER',
      categoryId: restaurants.id,
      createdAt: new Date('2026-10-02'),
    });
    const earlier = {
      ...rule({ keyword: 'grocer', categoryId: supermarket.id }),
      createdAt: new Date('2026-10-01'),
    };
    expect(matchRule('DOWNTOWN GROCER', [later, earlier])).toBe(earlier);
  });

  it('R7: is_system does not affect ordering inside step 3', () => {
    const preset = rule({ keyword: 'GROCER', categoryId: restaurants.id, isSystem: true });
    const mine = rule({ keyword: 'DOWNTOWN GROCER', categoryId: supermarket.id });
    expect(matchRule('DOWNTOWN GROCER', [preset, mine])).toBe(mine);
  });
});

describe('R7.1 正数金额', () => {
  it('R7.1: refund matching an expense rule goes to that expense category', () => {
    // classify 不看金额正负：MELB ASIAN MARKET +0.72 和支出一样
    expect(
      classify({ merchant: 'MELB ASIAN MARKET', isInternalTransfer: false }, h.rules, h.categories),
    ).toEqual({ categoryId: supermarket.id, categorySource: 'rule', isPreTax: false });
  });
});

describe('R7 is_pre_tax', () => {
  it('R7: isPreTax follows the category default (Income / Interest is pre-tax)', () => {
    const interest = h.category('Income / Interest');
    expect(interest.isPreTaxDefault).toBe(true);
    const rules = [rule({ keyword: 'CREDIT INTEREST', categoryId: interest.id })];
    expect(
      classify({ merchant: 'CREDIT INTEREST', isInternalTransfer: false }, rules, h.categories),
    ).toEqual({
      categoryId: interest.id,
      categorySource: 'rule',
      isPreTax: true,
    });
  });

  it('R7: non pre-tax category → false', () => {
    const rules = [rule({ keyword: 'KUMO', categoryId: coffee.id })];
    expect(
      classify({ merchant: 'KUMO MELBOURNE', isInternalTransfer: false }, rules, h.categories)
        .isPreTax,
    ).toBe(false);
  });
});

describe('R7 on fixtures', () => {
  // fixtures/README.md "期望结果：joint-2026-09.csv" 分类列（#5 "同上" = #4）
  // 转账：#11、#17 在 R6.1 里认成内部转账，这里用参数模拟；#18 外部账号不是
  const JOINT_CATEGORIES = [
    'Bank fees',
    'Bank fees',
    'Home & utilities / Electricity',
    'Entertainment & eat-out / Bubble tea',
    'Entertainment & eat-out / Bubble tea',
    'Cash withdrawal',
    'Uncategorised',
    'Entertainment & eat-out / Restaurants',
    'Groceries / Supermarket',
    'Personal & medical / Other',
    'Internal transfer',
    'Transport & auto / Petrol / EV charging',
    'Groceries / Supermarket',
    'Groceries / Supermarket',
    'Uncategorised',
    'Uncategorised',
    'Internal transfer',
    'Uncategorised',
    'Groceries / Supermarket',
  ];
  const TRANSFER_ROWS = new Set([11, 17]);

  it('R7: joint-2026-09.csv 19 categories match fixtures/README.md', () => {
    const rows = parseAnzCsv(readFixture('anz/joint-2026-09.csv'));
    const got = rows.map((r, i) => {
      const merchant = cleanMerchant(extractAndMask(r.description).description);
      const { categoryId } = classify(
        { merchant, isInternalTransfer: TRANSFER_ROWS.has(i + 1) },
        h.rules,
        h.categories,
      );
      return categoryId;
    });
    expect(got).toEqual(JOINT_CATEGORIES.map((p) => h.category(p).id));
  });
});
