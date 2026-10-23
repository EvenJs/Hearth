import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { readFixture } from '../../../tests/helpers/fixtures';
import { parseAnzCsv } from '../import/anz';
import { classify } from './classify';
import { extractAndMask } from './extract';
import { categoryDefaultMember, recomputeMember, resolveMember } from './member';
import { cleanMerchant } from './merchant';
import type { Category, MemberSource } from './types';

// 期望值来自 business-rules.md R5、R5.1 和 fixtures/README.md "期望结果：joint-2026-09.csv" 归属人列

const h = buildTestHousehold();
const ctx = { categories: h.categories, cards: h.cards, accounts: h.accounts };

const joint = h.account('ANZ Joint');
const male = h.account('ANZ Male');
const id = (name: string) => h.member(name).id;

describe('resolveMember（R5 表格）', () => {
  it.each<
    [account: string, card: string | null, category: string, member: string, source: MemberSource]
  >([
    ['ANZ Joint', '1111', 'Entertainment & eat-out / Coffee & tea', 'Male', 'card'],
    ['ANZ Joint', '1111', 'Groceries / Supermarket', 'Home', 'category'],
    ['ANZ Joint', '2222', 'Uncategorised', 'Female', 'card'],
    ['ANZ Joint', null, 'Entertainment & eat-out / Restaurants', 'Home', 'account'],
    ['ANZ Joint', '9999', 'Uncategorised', 'Home', 'account'],
    ['ANZ Male', null, 'Home & utilities / Water', 'Home', 'category'],
    ['ANZ Male', null, 'Transport & auto / Public transport', 'Male', 'account'],
  ])('R5: %s, card %s, %s → %s (%s)', (account, card, category, member, source) => {
    expect(
      resolveMember(
        { accountId: h.account(account).id, cardLast4: card, categoryId: h.category(category).id },
        ctx,
      ),
    ).toEqual({ memberId: id(member), memberSource: source });
  });

  it('R5 priority 1: manual member wins over everything', () => {
    expect(
      resolveMember(
        {
          accountId: joint.id,
          cardLast4: '1111',
          categoryId: h.category('Groceries / Supermarket').id,
          manualMemberId: id('Female'),
        },
        ctx,
      ),
    ).toEqual({ memberId: id('Female'), memberSource: 'manual' });
  });

  it('R5 priority 3: card lookup uses (account, last4), a card on another account does not count', () => {
    // 1111 只登记在 ANZ Joint 上
    expect(
      resolveMember(
        { accountId: male.id, cardLast4: '2222', categoryId: h.systemCategory('uncategorized').id },
        ctx,
      ),
    ).toEqual({ memberId: id('Male'), memberSource: 'account' });
  });

  it('R5: system categories have no category default, go to card then account', () => {
    for (const key of [
      'internal_transfer',
      'cash_withdrawal',
      'bank_fee',
      'uncategorized',
    ] as const) {
      expect(
        resolveMember(
          { accountId: joint.id, cardLast4: '2222', categoryId: h.systemCategory(key).id },
          ctx,
        ),
      ).toEqual({ memberId: id('Female'), memberSource: 'card' });
    }
  });
});

describe('categoryDefaultMember（R5 第 2 优先级）', () => {
  const top: Category = {
    id: 'cat:top',
    parentId: null,
    nameEn: 'Top',
    kind: 'expense',
    systemKey: null,
    defaultMemberId: 'member:Home',
    isPreTaxDefault: false,
    isOther: false,
  };
  const inherit: Category = { ...top, id: 'cat:inherit', parentId: top.id, defaultMemberId: null };
  const own: Category = { ...top, id: 'cat:own', parentId: top.id, defaultMemberId: 'member:Male' };
  const bareTop: Category = { ...top, id: 'cat:bare', defaultMemberId: null };
  const bareChild: Category = {
    ...top,
    id: 'cat:bare-child',
    parentId: bareTop.id,
    defaultMemberId: null,
  };
  const cats = [top, inherit, own, bareTop, bareChild];

  it('R5: subcategory without a default inherits the top-level one', () => {
    expect(categoryDefaultMember(inherit.id, cats)).toBe('member:Home');
    // seed 数据：二级都没设，Groceries / Supermarket 继承 Groceries 的 Home
    expect(categoryDefaultMember(h.category('Groceries / Supermarket').id, h.categories)).toBe(
      id('Home'),
    );
  });

  it('R5: subcategory with its own default uses it', () => {
    expect(categoryDefaultMember(own.id, cats)).toBe('member:Male');
  });

  it('R5: neither has a default → null', () => {
    expect(categoryDefaultMember(bareChild.id, cats)).toBeNull();
    expect(categoryDefaultMember(bareTop.id, cats)).toBeNull();
  });

  it('R5: top-level category uses its own default', () => {
    expect(categoryDefaultMember(top.id, cats)).toBe('member:Home');
  });
});

describe('recomputeMember（R5.1）', () => {
  const groceries = h.category('Groceries / Supermarket').id;
  const uncategorized = h.systemCategory('uncategorized').id;
  // fixtures/README.md 主表 #16：Joint，卡 2222，Uncategorised，Female (card)
  const row16 = { accountId: joint.id, cardLast4: '2222' };

  it('R5.1: #16 changed to Groceries / Supermarket → Home (category)', () => {
    expect(
      recomputeMember({ ...row16, memberId: id('Female'), memberSource: 'card' }, groceries, ctx),
    ).toEqual({ memberId: id('Home'), memberSource: 'category' });
  });

  it('R5.1: manual Female stays Female when category changes to Uncategorised', () => {
    expect(
      recomputeMember(
        { ...row16, memberId: id('Female'), memberSource: 'manual' },
        uncategorized,
        ctx,
      ),
    ).toEqual({ memberId: id('Female'), memberSource: 'manual' });
    expect(
      recomputeMember({ ...row16, memberId: id('Female'), memberSource: 'manual' }, groceries, ctx),
    ).toEqual({
      memberId: id('Female'),
      memberSource: 'manual',
    });
  });

  it('R5.1: category / account sources are recomputed too', () => {
    expect(
      recomputeMember(
        { ...row16, memberId: id('Home'), memberSource: 'category' },
        uncategorized,
        ctx,
      ),
    ).toEqual({ memberId: id('Female'), memberSource: 'card' });
    expect(
      recomputeMember(
        { accountId: joint.id, cardLast4: null, memberId: id('Home'), memberSource: 'account' },
        groceries,
        ctx,
      ),
    ).toEqual({ memberId: id('Home'), memberSource: 'category' });
  });
});

describe('R5 on fixtures', () => {
  // fixtures/README.md "期望结果：joint-2026-09.csv" 归属人列（括号里是 member_source）
  const JOINT_MEMBERS: [member: string, source: MemberSource][] = [
    ['Home', 'account'],
    ['Home', 'account'],
    ['Home', 'category'],
    ['Male', 'card'],
    ['Male', 'card'],
    ['Home', 'account'],
    ['Home', 'account'],
    ['Home', 'account'],
    ['Home', 'category'],
    ['Home', 'account'],
    ['Home', 'account'],
    ['Home', 'account'],
    ['Home', 'category'],
    ['Home', 'category'],
    ['Home', 'account'],
    ['Female', 'card'],
    ['Home', 'account'],
    ['Home', 'account'],
    ['Home', 'category'],
  ];
  // #11、#17 在 R6.1 里认成内部转账，这里用参数模拟（同 classify.test.ts）
  const TRANSFER_ROWS = new Set([11, 17]);

  it('R5: joint-2026-09.csv 19 members (with member_source) match fixtures/README.md', () => {
    const rows = parseAnzCsv(readFixture('anz/joint-2026-09.csv'));
    const got = rows.map((r, i) => {
      const { description, cardLast4 } = extractAndMask(r.description);
      const { categoryId } = classify(
        { merchant: cleanMerchant(description), isInternalTransfer: TRANSFER_ROWS.has(i + 1) },
        h.rules,
        h.categories,
      );
      return resolveMember({ accountId: joint.id, cardLast4, categoryId }, ctx);
    });
    expect(got).toEqual(JOINT_MEMBERS.map(([m, s]) => ({ memberId: id(m), memberSource: s })));
  });
});
