import { describe, expect, it } from 'vitest';
import {
  OTHER_NAME,
  SEED_CATEGORIES,
  SEED_MEMBERS,
  SEED_RULE_DEFAULTS,
  SEED_RULES,
  SEED_SYSTEM_CATEGORIES,
} from './data';

// 期望值全部来自 docs/seed-categories.md，不从实现反推

describe('seed members（seed-categories §1）', () => {
  it('has Male, Female (person) and Home (shared); Kid is not created yet', () => {
    expect(SEED_MEMBERS).toEqual([
      { name: 'Male', kind: 'person' },
      { name: 'Female', kind: 'person' },
      { name: 'Home', kind: 'shared' },
    ]);
  });
});

describe('seed categories（seed-categories §2、§3）', () => {
  // 不含自动生成的 Other
  const expectedChildCounts: Record<string, number> = {
    'Home & utilities': 11,
    'Insurance & financial': 3,
    Groceries: 5,
    'Personal & medical': 8,
    'Entertainment & eat-out': 11,
    'Transport & auto': 6,
    Work: 4,
    Income: 4,
  };

  it('has the 7 expense top-levels and 1 income top-level in doc order', () => {
    expect(SEED_CATEGORIES.map((c) => [c.nameEn, c.kind])).toEqual([
      ['Home & utilities', 'expense'],
      ['Insurance & financial', 'expense'],
      ['Groceries', 'expense'],
      ['Personal & medical', 'expense'],
      ['Entertainment & eat-out', 'expense'],
      ['Transport & auto', 'expense'],
      ['Work', 'expense'],
      ['Income', 'income'],
    ]);
  });

  it('each top-level has the documented number of subcategories (excluding Other)', () => {
    for (const c of SEED_CATEGORIES) {
      const named = c.children.filter((ch) => !ch.isOther);
      expect(named.length, c.nameEn).toBe(expectedChildCounts[c.nameEn]);
    }
  });

  it('each top-level has exactly one Other, generated last with isOther = true', () => {
    for (const c of SEED_CATEGORIES) {
      const others = c.children.filter((ch) => ch.nameEn === OTHER_NAME);
      expect(others, c.nameEn).toHaveLength(1);
      expect(others[0].isOther).toBe(true);
      expect(c.children.at(-1)?.nameEn).toBe(OTHER_NAME);
      expect(c.children.filter((ch) => ch.isOther)).toHaveLength(1);
    }
  });

  it('subcategory names are unique within each top-level', () => {
    for (const c of SEED_CATEGORIES) {
      const names = c.children.map((ch) => ch.nameEn);
      expect(new Set(names).size, c.nameEn).toBe(names.length);
    }
  });

  it('default members: Home for Home & utilities, Insurance & financial, Groceries; none for the rest', () => {
    expect(Object.fromEntries(SEED_CATEGORIES.map((c) => [c.nameEn, c.defaultMember]))).toEqual({
      'Home & utilities': 'Home',
      'Insurance & financial': 'Home',
      Groceries: 'Home',
      'Personal & medical': null,
      'Entertainment & eat-out': null,
      'Transport & auto': null,
      Work: null,
      Income: null,
    });
  });

  it('Work (2026-10-25): documented subcategories in doc order, then Other', () => {
    const work = SEED_CATEGORIES.find((c) => c.nameEn === 'Work');
    expect(work?.children.map((ch) => ch.nameEn)).toEqual([
      'Registration & licences',
      'Memberships & union',
      'Training & courses',
      'Tools & software',
      OTHER_NAME,
    ]);
  });

  it('every default member refers to a seed member', () => {
    const names = SEED_MEMBERS.map((m) => m.name);
    for (const c of SEED_CATEGORIES) {
      if (c.defaultMember !== null) expect(names).toContain(c.defaultMember);
    }
  });

  it('only Contract income (B2B) and Interest are pre-tax by default', () => {
    const preTax = SEED_CATEGORIES.flatMap((c) =>
      c.children.filter((ch) => ch.isPreTaxDefault).map((ch) => `${c.nameEn}/${ch.nameEn}`),
    );
    expect(preTax).toEqual(['Income/Contract income (B2B)', 'Income/Interest']);
  });
});

describe('system categories（seed-categories §4）', () => {
  it('has exactly 4 system categories with the documented keys and names', () => {
    expect(SEED_SYSTEM_CATEGORIES).toEqual([
      { systemKey: 'internal_transfer', nameEn: 'Internal transfer' },
      { systemKey: 'cash_withdrawal', nameEn: 'Cash withdrawal' },
      { systemKey: 'bank_fee', nameEn: 'Bank fees' },
      { systemKey: 'uncategorized', nameEn: 'Uncategorised' },
    ]);
  });

  it('system category names do not clash with normal top-levels', () => {
    const topNames = SEED_CATEGORIES.map((c) => c.nameEn);
    for (const s of SEED_SYSTEM_CATEGORIES) expect(topNames).not.toContain(s.nameEn);
  });
});

describe('seed rules（seed-categories §5）', () => {
  it('all rules are contains / priority 0 / is_system', () => {
    expect(SEED_RULE_DEFAULTS).toEqual({ matchType: 'contains', priority: 0, isSystem: true });
  });

  it('has the documented number of rules per top-level (83 total, none for Work)', () => {
    const counts: Record<string, number> = {};
    for (const r of SEED_RULES) counts[r.category] = (counts[r.category] ?? 0) + 1;
    expect(counts).toEqual({
      Groceries: 21,
      'Personal & medical': 14,
      'Entertainment & eat-out': 28,
      'Transport & auto': 5,
      'Home & utilities': 8,
      'Insurance & financial': 2,
      Income: 5,
    });
    expect(SEED_RULES).toHaveLength(83);
  });

  it('every rule points to an existing top-level and subcategory', () => {
    for (const r of SEED_RULES) {
      const top = SEED_CATEGORIES.find((c) => c.nameEn === r.category);
      expect(top, `${r.keyword} → ${r.category}`).toBeDefined();
      expect(
        top?.children.map((ch) => ch.nameEn),
        `${r.keyword} → ${r.category}/${r.subcategory}`,
      ).toContain(r.subcategory);
    }
  });

  it('keywords are stored uppercase, trimmed, without ❓ marks', () => {
    for (const r of SEED_RULES) {
      expect(r.keyword).toBe(r.keyword.toUpperCase());
      expect(r.keyword).toBe(r.keyword.trim());
      expect(r.keyword).not.toContain('❓');
    }
  });

  it('keywords are unique (category_rule unique on household, keyword, match_type)', () => {
    const keywords = SEED_RULES.map((r) => r.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('spot checks against the doc', () => {
    const find = (k: string) => SEED_RULES.find((r) => r.keyword === k);
    expect(find('SW WHITE')).toEqual({
      keyword: 'SW WHITE',
      category: 'Entertainment & eat-out',
      subcategory: 'Bubble tea',
    });
    expect(find('MEDICARE')).toMatchObject({
      category: 'Personal & medical',
      subcategory: 'Other',
    });
    expect(find('SEAFOOD')).toMatchObject({ category: 'Groceries', subcategory: 'Other' });
    // 2026-10-25：面包店从 Groceries / Other 挪到 Bakery
    expect(find('BREAD')).toMatchObject({
      category: 'Entertainment & eat-out',
      subcategory: 'Bakery',
    });
    expect(find('BAKERS')).toMatchObject({
      category: 'Entertainment & eat-out',
      subcategory: 'Bakery',
    });
    expect(find('BPAY GWW')).toMatchObject({ category: 'Home & utilities', subcategory: 'Water' });
    expect(find('SALARY')).toMatchObject({ category: 'Income', subcategory: 'Salary' });
    expect(find('TAX OFFICE')).toMatchObject({ category: 'Income', subcategory: 'Tax (ATO)' });
  });
});
