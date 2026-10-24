import { describe, expect, it } from 'vitest';
import {
  categoryOptionGroups,
  isCategoryLocked,
  shouldOfferRule,
  type CategoryTreeNode,
} from './inline-edit';

// 期望值来自 business-rules.md R16.2、R16.3、R16.9

const tree: CategoryTreeNode[] = [
  {
    id: 'groceries',
    nameEn: 'Groceries',
    kind: 'expense',
    systemKey: null,
    children: [
      { id: 'supermarket', nameEn: 'Supermarket' },
      { id: 'market', nameEn: 'Market' },
    ],
  },
  {
    id: 'income',
    nameEn: 'Income',
    kind: 'income',
    systemKey: null,
    children: [{ id: 'salary', nameEn: 'Salary' }],
  },
  {
    id: 'transfer',
    nameEn: 'Internal transfer',
    kind: 'system',
    systemKey: 'internal_transfer',
    children: [],
  },
  {
    id: 'cash',
    nameEn: 'Cash withdrawal',
    kind: 'system',
    systemKey: 'cash_withdrawal',
    children: [],
  },
  { id: 'fee', nameEn: 'Bank fee', kind: 'system', systemKey: 'bank_fee', children: [] },
  {
    id: 'uncat',
    nameEn: 'Uncategorized',
    kind: 'system',
    systemKey: 'uncategorized',
    children: [],
  },
];

describe('categoryOptionGroups', () => {
  it('R16.3: expense and income tops are groups, top itself selectable before its children', () => {
    const groups = categoryOptionGroups(tree);
    expect(groups[0]).toEqual({
      label: 'Groceries',
      options: [
        { id: 'groceries', label: 'Groceries', kind: 'expense' },
        { id: 'supermarket', label: 'Groceries / Supermarket', kind: 'expense' },
        { id: 'market', label: 'Groceries / Market', kind: 'expense' },
      ],
    });
    expect(groups[1].options.map((o) => o.id)).toEqual(['income', 'salary']);
  });

  it('R16.3: uncategorized, cash withdrawal and bank fee are selectable, internal transfer is not', () => {
    const groups = categoryOptionGroups(tree);
    const ids = groups.flatMap((g) => g.options.map((o) => o.id));
    expect(ids).toContain('uncat');
    expect(ids).toContain('cash');
    expect(ids).toContain('fee');
    expect(ids).not.toContain('transfer');
  });

  it('R16.3: system categories go into one group at the end', () => {
    const groups = categoryOptionGroups(tree);
    expect(groups.at(-1)).toEqual({
      label: '系统',
      options: [
        { id: 'cash', label: 'Cash withdrawal', kind: 'system' },
        { id: 'fee', label: 'Bank fee', kind: 'system' },
        { id: 'uncat', label: 'Uncategorized', kind: 'system' },
      ],
    });
  });
});

describe('isCategoryLocked', () => {
  it('R16.2: auto and confirmed transfers are read only', () => {
    expect(isCategoryLocked('auto')).toBe(true);
    expect(isCategoryLocked('confirmed')).toBe(true);
  });

  it('R16.2: suggested and none can be changed', () => {
    expect(isCategoryLocked('suggested')).toBe(false);
    expect(isCategoryLocked('none')).toBe(false);
  });
});

describe('shouldOfferRule', () => {
  it('R16.9: primary split changed to an expense or income category → offer', () => {
    expect(shouldOfferRule({ isPrimary: true, changed: true, newKind: 'expense' })).toBe(true);
    expect(shouldOfferRule({ isPrimary: true, changed: true, newKind: 'income' })).toBe(true);
  });

  it('R16.9: category did not change → no offer', () => {
    expect(shouldOfferRule({ isPrimary: true, changed: false, newKind: 'expense' })).toBe(false);
  });

  it('R16.9: changed to a system category (uncategorized, cash, bank fee) → no offer', () => {
    expect(shouldOfferRule({ isPrimary: true, changed: true, newKind: 'system' })).toBe(false);
  });

  it('R16.9: non-primary split of a split transaction → no offer', () => {
    expect(shouldOfferRule({ isPrimary: false, changed: true, newKind: 'expense' })).toBe(false);
  });
});
