import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import {
  changeCategory,
  changeMember,
  isSelectableCategory,
  planReapply,
  selectableCategories,
  typeOfCategory,
  type EditCategory,
  type EditResult,
  type EditSplit,
  type EditTarget,
  type ReapplyTx,
} from './split-edit';
import type { CategoryRule } from './types';

// 期望值来自 business-rules.md R5.1、R7、R7.2、R16.2–R16.5
// 和 fixtures/README.md "R5.1 重算"、cba/female "然后手动操作"

const h = buildTestHousehold();
const ctx = { categories: h.categories, cards: h.cards, accounts: h.accounts };
const cat = (path: string) => h.category(path).id;
const mem = (name: string) => h.member(name).id;
const UNCATEGORIZED = h.systemCategory('uncategorized').id;
const INTERNAL = h.systemCategory('internal_transfer').id;
const BANK_FEE = h.systemCategory('bank_fee').id;

const joint = h.account('ANZ Joint');
const female = h.account('CBA Female');

function ok(r: EditResult) {
  if (!r.ok) throw new Error(r.message);
  return r;
}

// joint-2026-09.csv #16：EASI AU ****2605，卡 2222，Uncategorised，Female（card）
function easi(): EditTarget {
  return {
    id: 'split:16',
    accountId: joint.id,
    cardLast4: '2222',
    transferStatus: 'none',
    categoryId: UNCATEGORIZED,
    categorySource: 'system',
    memberId: mem('Female'),
    memberSource: 'card',
    isPreTax: false,
  };
}

// 改完的拆分接回原来的交易字段，模拟入库后再读出来
const reload = (target: EditTarget, split: EditSplit): EditTarget => ({
  ...target,
  ...split,
});

describe('changeCategory（R16.4、R5.1）', () => {
  it('R5.1 step 1: #16 manually set to Groceries / Supermarket → member becomes Home (category)', () => {
    const r = ok(changeCategory(easi(), cat('Groceries / Supermarket'), ctx));
    expect(r.changed).toBe(true);
    expect(r.split).toEqual({
      id: 'split:16',
      categoryId: cat('Groceries / Supermarket'),
      categorySource: 'manual',
      memberId: mem('Home'),
      memberSource: 'category',
      isPreTax: false,
    });
  });

  it('R5.1 step 2: member manually set to Female, then category back to Uncategorised → member stays Female (manual)', () => {
    const step1 = reload(
      easi(),
      ok(changeCategory(easi(), cat('Groceries / Supermarket'), ctx)).split,
    );
    const step2 = reload(step1, changeMember(step1, mem('Female')));
    expect(step2).toMatchObject({
      memberId: mem('Female'),
      memberSource: 'manual',
    });

    const r = ok(changeCategory(step2, UNCATEGORIZED, ctx));
    expect(r.split).toEqual({
      id: 'split:16',
      categoryId: UNCATEGORIZED,
      categorySource: 'manual',
      memberId: mem('Female'),
      memberSource: 'manual',
      isPreTax: false,
    });
  });

  it('R7: is_pre_tax follows the new category default (cba #3 → Contract income (B2B) → true)', () => {
    const cba3: EditTarget = {
      id: 'split:cba3',
      accountId: female.id,
      cardLast4: null,
      transferStatus: 'none',
      categoryId: UNCATEGORIZED,
      categorySource: 'system',
      memberId: mem('Female'),
      memberSource: 'account',
      isPreTax: false,
    };
    const r = ok(changeCategory(cba3, cat('Income / Contract income (B2B)'), ctx));
    expect(r.split).toMatchObject({
      categorySource: 'manual',
      isPreTax: true,
      memberId: mem('Female'),
      memberSource: 'account',
    });
  });

  it('R7: a manually changed is_pre_tax is reset to the new category default', () => {
    const target = { ...easi(), isPreTax: true };
    const r = ok(changeCategory(target, cat('Groceries / Supermarket'), ctx));
    expect(r.split.isPreTax).toBe(false);
  });

  it('R5.1: same category → returned as is, category_source not changed to manual', () => {
    const target = easi();
    const r = ok(changeCategory(target, UNCATEGORIZED, ctx));
    expect(r.changed).toBe(false);
    expect(r.split).toEqual({
      id: 'split:16',
      categoryId: UNCATEGORIZED,
      categorySource: 'system',
      memberId: mem('Female'),
      memberSource: 'card',
      isPreTax: false,
    });
  });

  it.each(['auto', 'confirmed'] as const)(
    'R16.2: %s transfer row → error, category cannot be changed',
    (transferStatus) => {
      const row: EditTarget = {
        ...easi(),
        transferStatus,
        categoryId: INTERNAL,
        categorySource: transferStatus === 'auto' ? 'system' : 'manual',
      };
      expect(changeCategory(row, cat('Groceries / Supermarket'), ctx).ok).toBe(false);
    },
  );

  it('R16.2: suggested row can be changed like a normal one', () => {
    const r = ok(
      changeCategory(
        { ...easi(), transferStatus: 'suggested' },
        cat('Groceries / Supermarket'),
        ctx,
      ),
    );
    expect(r.split.categoryId).toBe(cat('Groceries / Supermarket'));
  });

  it('R16.3: choosing Internal transfer → error', () => {
    expect(changeCategory(easi(), INTERNAL, ctx).ok).toBe(false);
  });

  it('R16.3: choosing an archived category → error', () => {
    const categories: EditCategory[] = h.categories.map((c) =>
      c.id === cat('Groceries / Supermarket') ? { ...c, isArchived: true } : c,
    );
    expect(
      changeCategory(easi(), cat('Groceries / Supermarket'), {
        ...ctx,
        categories,
      }).ok,
    ).toBe(false);
  });

  it('R16.3: unknown category id → error', () => {
    expect(changeCategory(easi(), 'category:nope', ctx).ok).toBe(false);
  });
});

describe('changeMember（R16.4）', () => {
  it('R16.4: member_source = manual, category untouched', () => {
    expect(changeMember(easi(), mem('Home'))).toEqual({
      id: 'split:16',
      categoryId: UNCATEGORIZED,
      categorySource: 'system',
      memberId: mem('Home'),
      memberSource: 'manual',
      isPreTax: false,
    });
  });

  it('R16.2: transfer rows can still change member', () => {
    const row: EditTarget = {
      ...easi(),
      transferStatus: 'auto',
      categoryId: INTERNAL,
    };
    expect(changeMember(row, mem('Male'))).toMatchObject({
      categoryId: INTERNAL,
      memberId: mem('Male'),
      memberSource: 'manual',
    });
  });
});

describe('selectableCategories（R16.3）', () => {
  const ids = selectableCategories(h.categories).map((c) => c.id);

  it('R16.3: expense and income, top level and second level, are selectable', () => {
    expect(ids).toEqual(
      expect.arrayContaining([
        cat('Groceries'),
        cat('Groceries / Supermarket'),
        cat('Income'),
        cat('Income / Salary'),
      ]),
    );
  });

  it('R16.3: Uncategorised, Cash withdrawal, Bank fees are selectable; Internal transfer is not', () => {
    expect(ids).toEqual(
      expect.arrayContaining([UNCATEGORIZED, h.systemCategory('cash_withdrawal').id, BANK_FEE]),
    );
    expect(ids).not.toContain(INTERNAL);
    expect(isSelectableCategory(h.systemCategory('internal_transfer'))).toBe(false);
  });

  it('R16.3: archived categories are not selectable', () => {
    const categories: EditCategory[] = h.categories.map((c) =>
      c.id === cat('Income / Salary') ? { ...c, isArchived: true } : c,
    );
    const r = selectableCategories(categories).map((c) => c.id);
    expect(r).not.toContain(cat('Income / Salary'));
    expect(r).toContain(cat('Income / Interest'));
  });

  it('R16.3: keeps input order, everything except Internal transfer when nothing is archived', () => {
    expect(ids).toEqual(h.categories.filter((c) => c.id !== INTERNAL).map((c) => c.id));
  });
});

describe('typeOfCategory（R16.5）', () => {
  it.each<[string, string]>([
    ['Income / Salary', 'income'],
    ['Income', 'income'],
    ['Groceries / Supermarket', 'expense'],
    ['Personal & medical / Other', 'expense'], // MEDICARE BENEFIT +45.80 算支出
    ['Cash withdrawal', 'expense'],
    ['Bank fees', 'expense'],
    ['Internal transfer', 'internal_transfer'],
    ['Uncategorised', 'uncategorized'],
  ])('R16.5: %s → %s', (path, type) => {
    expect(typeOfCategory(h.category(path))).toBe(type);
  });
});

describe('planReapply（R7.2）', () => {
  const RESTAURANTS = cat('Entertainment & eat-out / Restaurants');
  const SUPERMARKET = cat('Groceries / Supermarket');

  function rule(keyword: string, categoryId: string, i: number): CategoryRule {
    return {
      id: `rule:new:${keyword}`,
      keyword,
      matchType: 'contains',
      categoryId,
      priority: 0,
      isSystem: false,
      createdAt: new Date(Date.UTC(2026, 9, 24) + i * 1000),
    };
  }

  function tx(
    id: string,
    merchant: string,
    cardLast4: string | null,
    split: Omit<EditSplit, 'id'>,
    extraSplits = 0,
  ): ReapplyTx {
    const splits: EditSplit[] = [{ id: `split:${id}`, ...split }];
    for (let i = 0; i < extraSplits; i++) {
      splits.push({
        ...split,
        id: `split:${id}:${i}`,
        categorySource: 'manual',
      });
    }
    return {
      id,
      accountId: joint.id,
      merchant,
      cardLast4,
      transferStatus: 'none',
      splits,
    };
  }

  // joint #15：UNKNOWN SHOP，卡 3333 未登记，Uncategorised，Home（account）
  const unknownShop = () =>
    tx('15', 'UNKNOWN SHOP PTY LTD MELBOURNE', '3333', {
      categoryId: UNCATEGORIZED,
      categorySource: 'system',
      memberId: mem('Home'),
      memberSource: 'account',
      isPreTax: false,
    });

  // joint #19：COLES，卡 1111，规则 COLES → Supermarket，Home（category）
  const coles = (over: Partial<EditSplit> = {}, extraSplits = 0) =>
    tx(
      '19',
      'COLES 0559 MELBOURNE',
      '1111',
      {
        categoryId: SUPERMARKET,
        categorySource: 'rule',
        memberId: mem('Home'),
        memberSource: 'category',
        isPreTax: false,
        ...over,
      },
      extraSplits,
    );

  // joint #2：ACCOUNT SERVICING FEE，Bank fees（system）
  const bankFee = () =>
    tx('2', 'ACCOUNT SERVICING FEE', null, {
      categoryId: BANK_FEE,
      categorySource: 'system',
      memberId: mem('Home'),
      memberSource: 'account',
      isPreTax: false,
    });

  it('R7.2: uncategorised (source system) is changed by a new rule', () => {
    const rules = [...h.rules, rule('UNKNOWN SHOP', RESTAURANTS, 0)];
    expect(planReapply([unknownShop()], rules, ctx)).toEqual({
      updates: [
        {
          transactionId: '15',
          split: {
            id: 'split:15',
            categoryId: RESTAURANTS,
            categorySource: 'rule',
            memberId: mem('Home'),
            memberSource: 'account',
            isPreTax: false,
          },
        },
      ],
      skipped: 0,
    });
  });

  it('R7.2 + R5.1: rule-sourced split moved to another category recomputes member (COLES → Restaurants: Home (category) → Male (card))', () => {
    const rules = [...h.rules, rule('COLES 0559', RESTAURANTS, 0)];
    expect(planReapply([coles()], rules, ctx).updates).toEqual([
      {
        transactionId: '19',
        split: {
          id: 'split:19',
          categoryId: RESTAURANTS,
          categorySource: 'rule',
          memberId: mem('Male'),
          memberSource: 'card',
          isPreTax: false,
        },
      },
    ]);
  });

  it('R7.2 + R5.1: manual member is kept when the category changes', () => {
    const rules = [...h.rules, rule('COLES 0559', RESTAURANTS, 0)];
    const [u] = planReapply(
      [coles({ memberId: mem('Female'), memberSource: 'manual' })],
      rules,
      ctx,
    ).updates;
    expect(u.split).toMatchObject({
      categoryId: RESTAURANTS,
      memberId: mem('Female'),
      memberSource: 'manual',
    });
  });

  it('R7.2: is_pre_tax follows the new category default', () => {
    const rules = [...h.rules, rule('UNKNOWN SHOP', cat('Income / Contract income (B2B)'), 0)];
    const [u] = planReapply([unknownShop()], rules, ctx).updates;
    expect(u.split.isPreTax).toBe(true);
  });

  it('R7.2: rule-sourced split whose result is the same category is not in updates', () => {
    expect(planReapply([coles()], h.rules, ctx)).toEqual({
      updates: [],
      skipped: 0,
    });
  });

  it('R7.2: uncategorised that still matches nothing is not in updates', () => {
    expect(planReapply([unknownShop()], h.rules, ctx)).toEqual({
      updates: [],
      skipped: 0,
    });
  });

  it('R7.2: manual category is not touched', () => {
    const rules = [...h.rules, rule('COLES 0559', SUPERMARKET, 0)];
    const manual = coles({ categoryId: RESTAURANTS, categorySource: 'manual' });
    expect(planReapply([manual], rules, ctx)).toEqual({
      updates: [],
      skipped: 0,
    });
  });

  it('R7.2: system category other than uncategorised (Bank fees) is not touched', () => {
    const rules = [...h.rules, rule('ACCOUNT SERVICING', RESTAURANTS, 0)];
    expect(planReapply([bankFee()], rules, ctx)).toEqual({
      updates: [],
      skipped: 0,
    });
  });

  it('R7.2: Internal transfer (system) is not touched', () => {
    const t = tx('11', 'TRANSFER TO ****0003', null, {
      categoryId: INTERNAL,
      categorySource: 'system',
      memberId: mem('Home'),
      memberSource: 'account',
      isPreTax: false,
    });
    const auto: ReapplyTx = { ...t, transferStatus: 'auto' };
    const rules = [...h.rules, rule('TRANSFER', RESTAURANTS, 0)];
    expect(planReapply([auto], rules, ctx)).toEqual({
      updates: [],
      skipped: 0,
    });
  });

  it('R7.2: transaction with several splits is skipped and counted', () => {
    const rules = [...h.rules, rule('COLES 0559', RESTAURANTS, 0)];
    expect(planReapply([coles({}, 2)], rules, ctx)).toEqual({
      updates: [],
      skipped: 1,
    });
  });

  it('R7.2: mixed list — only eligible single-split rows change, multi-split counted as skipped', () => {
    const rules = [
      ...h.rules,
      rule('UNKNOWN SHOP', RESTAURANTS, 0),
      rule('ACCOUNT SERVICING', RESTAURANTS, 1),
    ];
    const multi: ReapplyTx = {
      ...unknownShop(),
      id: '15b',
      splits: coles({}, 1).splits,
    };
    const r = planReapply([unknownShop(), coles(), bankFee(), multi], rules, ctx);
    expect(r.updates.map((u) => u.transactionId)).toEqual(['15']);
    expect(r.skipped).toBe(1);
  });
});
