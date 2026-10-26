import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { normalizeKeyword } from './keyword';
import { checkRuleEdit, filterRules, ruleHits, type RuleEditResult } from './rule-admin';
import { planReapply, type EditCategory, type EditSplit, type ReapplyTx } from './split-edit';
import type { CategoryRule, RuleMatchType, TransferStatus } from './types';

// 期望值来自 business-rules.md R7、R16.3、R18.1、R18.2、R18.4

const h = buildTestHousehold();
const ctx = { categories: h.categories, cards: h.cards, accounts: h.accounts };
const cat = (path: string) => h.category(path).id;
const mem = (name: string) => h.member(name).id;
const UNCATEGORIZED = h.systemCategory('uncategorized').id;
const INTERNAL = h.systemCategory('internal_transfer').id;
const SUPERMARKET = cat('Groceries / Supermarket');
const COFFEE = cat('Entertainment & eat-out / Coffee & tea');
const RESTAURANTS = cat('Entertainment & eat-out / Restaurants');
const joint = h.account('ANZ Joint');

let seq = 0;
function rule(
  keyword: string,
  categoryId: string,
  matchType: RuleMatchType = 'contains',
): CategoryRule {
  seq++;
  return {
    id: `rule:new:${keyword}:${matchType}`,
    keyword,
    matchType,
    categoryId,
    priority: 0,
    isSystem: false,
    createdAt: new Date(Date.UTC(2026, 9, 26) + seq * 1000),
  };
}

const seedRule = (keyword: string) => h.rules.find((r) => r.keyword === keyword)!;

// joint 账户上只有一个拆分的交易
function tx(
  id: string,
  merchant: string,
  split: Omit<EditSplit, 'id'>,
  transferStatus: TransferStatus = 'none',
  cardLast4: string | null = null,
): ReapplyTx {
  return {
    id,
    accountId: joint.id,
    merchant,
    cardLast4,
    transferStatus,
    splits: [{ id: `split:${id}`, ...split }],
  };
}

const uncategorised = (id: string, merchant: string, transferStatus: TransferStatus = 'none') =>
  tx(
    id,
    merchant,
    {
      categoryId: UNCATEGORIZED,
      categorySource: 'system',
      memberId: mem('Home'),
      memberSource: 'account',
      isPreTax: false,
    },
    transferStatus,
  );

// ---------- R18.1 ----------

describe('ruleHits（R18.1）', () => {
  const colesExpress = rule('COLES EXPRESS', SUPERMARKET);
  const rules = [...h.rules, colesExpress];

  it('R18.1 + R7: COLES EXPRESS 1234 counts only for COLES EXPRESS (longer keyword wins), COLES 0559 MELBOURNE for COLES', () => {
    const hits = ruleHits(
      [uncategorised('1', 'COLES EXPRESS 1234'), uncategorised('2', 'COLES 0559 MELBOURNE')],
      rules,
    );
    expect(hits.get(colesExpress.id)).toBe(1);
    expect(hits.get(seedRule('COLES').id)).toBe(1);
  });

  it('R18.1: every rule is in the result, rules with no hits are 0', () => {
    const hits = ruleHits([], rules);
    expect(hits.size).toBe(rules.length);
    expect(hits.get(colesExpress.id)).toBe(0);
  });

  it('R18.1: internal transfers (auto, confirmed) are not counted even if merchant contains the keyword', () => {
    const hits = ruleHits(
      [
        uncategorised('1', 'FUNDS TFER COLES', 'auto'),
        uncategorised('2', 'FUNDS TFER COLES', 'confirmed'),
      ],
      rules,
    );
    expect(hits.get(seedRule('COLES').id)).toBe(0);
  });

  it('R18.1: suggested transfers are not internal transfers yet, so they are counted', () => {
    const hits = ruleHits([uncategorised('1', 'FUNDS TFER COLES', 'suggested')], rules);
    expect(hits.get(seedRule('COLES').id)).toBe(1);
  });

  it('R18.1 + R7 step 2: merchant starting with ATM or containing ACCOUNT SERVICING FEE is not counted', () => {
    const fee = rule('SERVICING', RESTAURANTS);
    const hits = ruleHits(
      [
        uncategorised('1', 'ATM COLES 0559 MELBOURNE'),
        uncategorised('2', 'REVERSAL OF ACCOUNT SERVICING FEE'),
      ],
      [...rules, fee],
    );
    expect(hits.get(seedRule('COLES').id)).toBe(0);
    expect(hits.get(fee.id)).toBe(0);
  });

  it('R18.1: current category and source do not matter — a manual split is still counted', () => {
    const manual = tx('1', 'COLES 0559 MELBOURNE', {
      categoryId: RESTAURANTS,
      categorySource: 'manual',
      memberId: mem('Female'),
      memberSource: 'manual',
      isPreTax: false,
    });
    expect(ruleHits([manual], rules).get(seedRule('COLES').id)).toBe(1);
  });

  it('R18.1: starts_with rule counts only merchants that start with the keyword', () => {
    const sw = rule('BLUE', COFFEE, 'starts_with');
    const hits = ruleHits(
      [uncategorised('1', 'BLUE DOOR MELBOURNE'), uncategorised('2', 'BIG BLUE DOOR')],
      [sw],
    );
    expect(hits.get(sw.id)).toBe(1);
  });
});

// ---------- R18.2 ----------

function err(r: RuleEditResult): string {
  if (r.ok) throw new Error('应该报错');
  return r.message;
}

describe('normalizeKeyword（R13、R18.2）', () => {
  it('R18.2: trims, collapses spaces, uppercases', () => {
    expect(normalizeKeyword('  blue   cafe ')).toBe('BLUE CAFE');
  });
});

describe('checkRuleEdit（R18.2、R16.3）', () => {
  const a = rule('BLUE DOOR', COFFEE);
  const b = rule('POCHANA THAI', RESTAURANTS);
  const rules = [...h.rules, a, b];

  it('R18.2: new rule keyword is normalized', () => {
    expect(
      checkRuleEdit(
        { keyword: '  blue   cafe ', matchType: 'contains', categoryId: COFFEE },
        rules,
        h.categories,
      ),
    ).toEqual({
      ok: true,
      value: { keyword: 'BLUE CAFE', matchType: 'contains', categoryId: COFFEE },
    });
  });

  it('R18.2: empty keyword (only spaces) is an error', () => {
    const r = checkRuleEdit(
      { keyword: '   ', matchType: 'contains', categoryId: COFFEE },
      rules,
      h.categories,
    );
    expect(err(r)).toBe('关键词不能为空');
  });

  it('R18.2: keyword longer than 100 characters is an error, exactly 100 is fine', () => {
    const long = checkRuleEdit(
      { keyword: 'A'.repeat(101), matchType: 'contains', categoryId: COFFEE },
      rules,
      h.categories,
    );
    expect(err(long)).toBe('关键词最长 100 个字符');
    const max = checkRuleEdit(
      { keyword: 'A'.repeat(100), matchType: 'contains', categoryId: COFFEE },
      rules,
      h.categories,
    );
    expect(max.ok).toBe(true);
  });

  it('R18.2: changing A keyword to B keyword (same match type) is an error naming B category', () => {
    const r = checkRuleEdit(
      { keyword: 'pochana thai', matchType: 'contains', categoryId: COFFEE },
      rules,
      h.categories,
      a.id,
    );
    expect(err(r)).toBe('已有规则 POCHANA THAI → Entertainment & eat-out / Restaurants');
    if (!r.ok) expect(r.conflictRuleId).toBe(b.id);
  });

  it('R18.2: new rule colliding with a seed rule is an error', () => {
    const r = checkRuleEdit(
      { keyword: 'coles', matchType: 'contains', categoryId: RESTAURANTS },
      rules,
      h.categories,
    );
    expect(err(r)).toBe('已有规则 COLES → Groceries / Supermarket');
  });

  it('R18.2: changing only A category (keyword unchanged) is not a collision', () => {
    const r = checkRuleEdit(
      { keyword: 'BLUE DOOR', matchType: 'contains', categoryId: RESTAURANTS },
      rules,
      h.categories,
      a.id,
    );
    expect(r).toEqual({
      ok: true,
      value: { keyword: 'BLUE DOOR', matchType: 'contains', categoryId: RESTAURANTS },
    });
  });

  it('R18.2: CAFE contains and CAFE starts_with can both exist', () => {
    const r = checkRuleEdit(
      { keyword: 'CAFE', matchType: 'starts_with', categoryId: COFFEE },
      rules,
      h.categories,
    );
    expect(r.ok).toBe(true);
  });

  it('R18.2 + R16.3: Internal transfer is not selectable', () => {
    const r = checkRuleEdit(
      { keyword: 'BLUE CAFE', matchType: 'contains', categoryId: INTERNAL },
      rules,
      h.categories,
    );
    expect(err(r)).toBe('不能选这个分类');
  });

  it('R18.2 + R16.3: archived category is not selectable', () => {
    const categories: EditCategory[] = h.categories.map((c) =>
      c.id === COFFEE ? { ...c, isArchived: true } : c,
    );
    const r = checkRuleEdit(
      { keyword: 'BLUE CAFE', matchType: 'contains', categoryId: COFFEE },
      rules,
      categories,
    );
    expect(err(r)).toBe('不能选这个分类');
  });

  it('R18.2 + R16.3: second level under an archived top level is not selectable', () => {
    const categories: EditCategory[] = h.categories.map((c) =>
      c.id === cat('Entertainment & eat-out') ? { ...c, isArchived: true } : c,
    );
    const r = checkRuleEdit(
      { keyword: 'BLUE CAFE', matchType: 'contains', categoryId: COFFEE },
      rules,
      categories,
    );
    expect(err(r)).toBe('不能选这个分类');
  });

  it('R18.2: unknown category id is an error', () => {
    const r = checkRuleEdit(
      { keyword: 'BLUE CAFE', matchType: 'contains', categoryId: 'category:nope' },
      rules,
      h.categories,
    );
    expect(err(r)).toBe('不能选这个分类');
  });
});

// ---------- R18.1 筛选 ----------

describe('filterRules（R18.1）', () => {
  const rules = [
    rule('WOOLWORTHS', SUPERMARKET),
    rule('CAFE', COFFEE, 'starts_with'),
    rule('BLUE CAFE', COFFEE),
    rule('CAFE', COFFEE),
    rule('POCHANA', RESTAURANTS),
    rule('ENTERTAIN TOP', cat('Entertainment & eat-out')),
  ];
  const keys = (rs: CategoryRule[]) => rs.map((r) => `${r.keyword}:${r.matchType}`);

  it('R18.1: sorted by keyword; same keyword keeps contains before starts_with', () => {
    expect(keys(filterRules(rules, {}, h.categories))).toEqual([
      'BLUE CAFE:contains',
      'CAFE:contains',
      'CAFE:starts_with',
      'ENTERTAIN TOP:contains',
      'POCHANA:contains',
      'WOOLWORTHS:contains',
    ]);
  });

  it('R18.1: search is contains, case-insensitive, trimmed', () => {
    expect(keys(filterRules(rules, { search: '  cafe ' }, h.categories))).toEqual([
      'BLUE CAFE:contains',
      'CAFE:contains',
      'CAFE:starts_with',
    ]);
  });

  it('R18.1: empty search means no filter', () => {
    expect(filterRules(rules, { search: '   ' }, h.categories)).toHaveLength(rules.length);
  });

  it('R18.1: top-level filter includes rules pointing at the top level itself and its second levels', () => {
    expect(
      keys(filterRules(rules, { topCategoryId: cat('Entertainment & eat-out') }, h.categories)),
    ).toEqual([
      'BLUE CAFE:contains',
      'CAFE:contains',
      'CAFE:starts_with',
      'ENTERTAIN TOP:contains',
      'POCHANA:contains',
    ]);
  });

  it('R18.1: search and top-level filter combine', () => {
    expect(
      keys(
        filterRules(
          rules,
          { search: 'blue', topCategoryId: cat('Entertainment & eat-out') },
          h.categories,
        ),
      ),
    ).toEqual(['BLUE CAFE:contains']);
    expect(
      filterRules(rules, { search: 'blue', topCategoryId: cat('Groceries') }, h.categories),
    ).toEqual([]);
  });

  it('R18.1: does not mutate the input array', () => {
    const before = keys(rules);
    filterRules(rules, {}, h.categories);
    expect(keys(rules)).toEqual(before);
  });
});

// ---------- R18.4 ----------

describe('R18.4 例子：BLUE CAFE BAR 和规则 CAFE → Coffee & tea', () => {
  const cafe = seedRule('CAFE');

  // BLUE CAFE BAR 被 CAFE 分成 Coffee & tea（rule）。joint 没有卡号 → Home（account），R5 表第 4 行
  const blueCafeBar = () =>
    tx('blue', 'BLUE CAFE BAR', {
      categoryId: COFFEE,
      categorySource: 'rule',
      memberId: mem('Home'),
      memberSource: 'account',
      isPreTax: false,
    });

  it('R18.4 setup: BLUE CAFE BAR is won by CAFE under seed rules', () => {
    expect(ruleHits([blueCafeBar()], h.rules).get(cafe.id)).toBe(1);
  });

  // 不应用：只改规则表，planReapply 不跑，交易原样。入库的版本在 M6.5-3（pnpm test:db）
  const RULES_AFTER: [op: string, rules: () => CategoryRule[]][] = [
    ['delete CAFE', () => h.rules.filter((r) => r.id !== cafe.id)],
    [
      'rename CAFE → BLUE CAFE',
      () => h.rules.map((r) => (r.id === cafe.id ? { ...r, keyword: 'BLUE CAFE' } : r)),
    ],
    [
      'CAFE category → Restaurants',
      () => h.rules.map((r) => (r.id === cafe.id ? { ...r, categoryId: RESTAURANTS } : r)),
    ],
  ];
  it.each(RULES_AFTER)(
    'R18.4 %s, not applied: BLUE CAFE BAR is still Coffee & tea (rule)',
    (_op, after) => {
      const t = blueCafeBar();
      after(); // 规则变了，交易不动
      expect(t.splits[0]).toEqual(blueCafeBar().splits[0]);
      expect(t.splits[0]).toMatchObject({ categoryId: COFFEE, categorySource: 'rule' });
    },
  );

  it('R18.4 delete CAFE, applied: BLUE CAFE BAR becomes Uncategorised', () => {
    const rules = h.rules.filter((r) => r.id !== cafe.id);
    expect(planReapply([blueCafeBar()], rules, ctx)).toEqual({
      updates: [
        {
          transactionId: 'blue',
          split: {
            id: 'split:blue',
            categoryId: UNCATEGORIZED,
            categorySource: 'system',
            memberId: mem('Home'),
            memberSource: 'account',
            isPreTax: false,
          },
        },
      ],
      skipped: 0,
    });
  });

  it('R18.4 rename CAFE → BLUE CAFE, applied: still Coffee & tea, nothing to update', () => {
    const rules = h.rules.map((r) => (r.id === cafe.id ? { ...r, keyword: 'BLUE CAFE' } : r));
    expect(planReapply([blueCafeBar()], rules, ctx)).toEqual({ updates: [], skipped: 0 });
  });

  it('R18.4 CAFE category → Restaurants, applied: becomes Restaurants (rule), member recomputed by R5.1 → Home (account)', () => {
    const rules = h.rules.map((r) => (r.id === cafe.id ? { ...r, categoryId: RESTAURANTS } : r));
    expect(planReapply([blueCafeBar()], rules, ctx).updates).toEqual([
      {
        transactionId: 'blue',
        split: {
          id: 'split:blue',
          categoryId: RESTAURANTS,
          categorySource: 'rule',
          memberId: mem('Home'),
          memberSource: 'account',
          isPreTax: false,
        },
      },
    ]);
  });

  it('R18.4 + R5.1 CAFE category → Groceries / Supermarket, applied: member recomputed to Home (category) even with card 1111 → Male', () => {
    // 换一个有分类默认的分类，让 R5.1 重算看得出来：卡 1111 → Male（card），Groceries 默认 Home
    const t = tx(
      'blue',
      'BLUE CAFE BAR',
      {
        categoryId: COFFEE,
        categorySource: 'rule',
        memberId: mem('Male'),
        memberSource: 'card',
        isPreTax: false,
      },
      'none',
      '1111',
    );
    const rules = h.rules.map((r) => (r.id === cafe.id ? { ...r, categoryId: SUPERMARKET } : r));
    expect(planReapply([t], rules, ctx).updates[0].split).toMatchObject({
      categoryId: SUPERMARKET,
      memberId: mem('Home'),
      memberSource: 'category',
    });
  });
});
