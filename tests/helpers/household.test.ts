import { describe, expect, it } from 'vitest';
import { SEED_CATEGORIES, SEED_RULES, SEED_SYSTEM_CATEGORIES } from '@/lib/seed/data';
import { readFixture } from './fixtures';
import { buildTestHousehold } from './household';

// 期望值来自 fixtures/README.md "测试用的家庭配置" 和 docs/seed-categories.md

describe('test household（fixtures/README.md 测试用的家庭配置）', () => {
  const h = buildTestHousehold();

  it('has Male, Female (person) and Home (shared)', () => {
    expect(h.members.map((m) => [m.name, m.kind])).toEqual([
      ['Male', 'person'],
      ['Female', 'person'],
      ['Home', 'shared'],
    ]);
  });

  it('has the 5 documented accounts', () => {
    expect(
      h.accounts.map((a) => [
        a.name,
        a.bank,
        a.type,
        h.members.find((m) => m.id === a.defaultMemberId)?.name,
        a.numberSuffix,
      ]),
    ).toEqual([
      ['ANZ Joint', 'anz', 'joint', 'Home', '0001'],
      ['ANZ Male', 'anz', 'everyday', 'Male', '0002'],
      ['CBA Female', 'cba', 'everyday', 'Female', '0003'],
      ['CBA Female Saver', 'cba', 'savings', 'Female', '7777'],
      ['ANZ Plus Male', 'anz_plus', 'savings', 'Male', '0004'],
    ]);
  });

  it('has cards 1111 → Male and 2222 → Female, both on ANZ Joint', () => {
    const joint = h.account('ANZ Joint');
    expect(h.cards.map((c) => [c.accountId, c.last4, c.memberId])).toEqual([
      [joint.id, '1111', h.member('Male').id],
      [joint.id, '2222', h.member('Female').id],
    ]);
  });

  it('category count matches seed data (7 top + 47 named + 7 Other + 4 system = 65)', () => {
    const fromSeed =
      SEED_CATEGORIES.length +
      SEED_CATEGORIES.reduce((n, c) => n + c.children.length, 0) +
      SEED_SYSTEM_CATEGORIES.length;
    expect(h.categories).toHaveLength(fromSeed);
    expect(h.categories).toHaveLength(65);
  });

  it('category ids are unique', () => {
    const ids = h.categories.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('R5: Home & utilities, Insurance & financial, Groceries default to Home; children inherit (null)', () => {
    const home = h.member('Home').id;
    expect(h.category('Groceries').defaultMemberId).toBe(home);
    expect(h.category('Home & utilities').defaultMemberId).toBe(home);
    expect(h.category('Insurance & financial').defaultMemberId).toBe(home);
    expect(h.category('Entertainment & eat-out').defaultMemberId).toBeNull();
    expect(h.category('Groceries / Supermarket').defaultMemberId).toBeNull();
    expect(h.category('Groceries / Supermarket').parentId).toBe(h.category('Groceries').id);
  });

  it('children share the kind of their parent; system categories are kind system', () => {
    expect(h.category('Income / Interest').kind).toBe('income');
    expect(h.category('Income / Interest').isPreTaxDefault).toBe(true);
    expect(h.category('Income / Salary').isPreTaxDefault).toBe(false);
    expect(h.category('Groceries / Other').isOther).toBe(true);
    for (const key of [
      'internal_transfer',
      'cash_withdrawal',
      'bank_fee',
      'uncategorized',
    ] as const) {
      expect(h.systemCategory(key).kind).toBe('system');
      expect(h.systemCategory(key).parentId).toBeNull();
    }
  });

  it('has all 83 seed rules, contains / priority 0 / is_system, pointing to real categories', () => {
    expect(h.rules).toHaveLength(SEED_RULES.length);
    expect(h.rules).toHaveLength(83);
    const ids = new Set(h.categories.map((c) => c.id));
    for (const r of h.rules) {
      expect(ids.has(r.categoryId), r.keyword).toBe(true);
      expect([r.matchType, r.priority, r.isSystem]).toEqual(['contains', 0, true]);
    }
    expect(h.rules.find((r) => r.keyword === 'COLES')?.categoryId).toBe(
      h.category('Groceries / Supermarket').id,
    );
  });

  it('lookup helpers throw on unknown names', () => {
    expect(() => h.member('Kid')).toThrow();
    expect(() => h.category('Groceries / Nope')).toThrow();
  });
});

describe('readFixture（fixtures/README.md 格式说明）', () => {
  it('reads ANZ and CBA files as-is, keeping CRLF', () => {
    const joint = readFixture('anz/joint-2026-09.csv');
    expect(joint.startsWith('30/09/2026,"5.00",')).toBe(true);
    expect(joint).toContain('\r\n');
    expect(readFixture('cba/female-2026-09.csv')).toContain('\r\n');
  });

  it('the -lf file has LF line endings only', () => {
    expect(readFixture('anz/joint-2026-09-lf.csv')).not.toContain('\r');
  });

  it('rejects paths outside anz/ and cba/', () => {
    // @ts-expect-error 类型上也不允许
    expect(() => readFixture('README.md')).toThrow();
    expect(() => readFixture('anz/../README.md' as 'anz/x.csv')).toThrow();
  });
});
