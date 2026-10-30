import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import {
  activeDuplicates,
  applyManualEdit,
  buildManualTransaction,
  canEditManual,
  frequentCategories,
  guessCategory,
  type ManualContext,
  type ManualEditTx,
  type ManualInput,
  type ManualSplit,
  type RecentManualUse,
} from './manual';
import type { Account } from './types';

// 期望值来自 business-rules.md R5、R7、R8.1、R17.1–R17.3、R17.5、R17.6
// 和 fixtures/README.md "pending 匹配用例"（P3、P4、P7、P8）

const h = buildTestHousehold();
// fixtures 家庭没有现金账户，这里补一个（bank = cash，默认 Home）
const cash: Account = {
  id: 'account:Cash',
  name: 'Cash',
  bank: 'cash',
  type: 'cash',
  defaultMemberId: h.member('Home').id,
  numberSuffix: null,
};
const TODAY = '2026-10-26';
const ctx: ManualContext = {
  members: h.members,
  accounts: [...h.accounts, cash],
  cards: h.cards,
  categories: h.categories,
  rules: h.rules,
  today: TODAY,
};
const cat = (path: string) => h.category(path).id;
const mem = (name: string) => h.member(name).id;
const acc = (name: string) => h.account(name).id;
const UNCATEGORIZED = h.systemCategory('uncategorized').id;
const CASH_WITHDRAWAL = h.systemCategory('cash_withdrawal').id;
const BANK_FEE = h.systemCategory('bank_fee').id;
const INTERNAL = h.systemCategory('internal_transfer').id;

function input(over: Partial<ManualInput> = {}): ManualInput {
  return {
    amount: '12.50',
    kind: 'expense',
    description: 'Coffee Lab',
    accountId: cash.id,
    date: TODAY,
    categoryId: null,
    categoryGuessed: false,
    memberId: null,
    ...over,
  };
}

function built(over: Partial<ManualInput> = {}, c: ManualContext = ctx) {
  const r = buildManualTransaction(input(over), c);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
}

function errors(over: Partial<ManualInput>, c: ManualContext = ctx) {
  const r = buildManualTransaction(input(over), c);
  if (r.ok) throw new Error('应该报错');
  return r.errors;
}

// ---------- buildManualTransaction ----------

describe('buildManualTransaction: status (R8.1)', () => {
  it('R8.1: cash account → confirmed', () => {
    expect(built({ accountId: cash.id }).transaction.status).toBe('confirmed');
  });

  it('R8.1: ANZ Joint → pending', () => {
    expect(built({ accountId: acc('ANZ Joint') }).transaction.status).toBe('pending');
  });

  it('R8.1 P8: CBA Female -15.00 → pending', () => {
    const r = built({ accountId: acc('CBA Female'), amount: '15.00' });
    expect(r.transaction.status).toBe('pending');
    expect(r.transaction.amountCents).toBe(-1500);
  });

  it('R8.1 P7: ANZ Plus Male +8.50 Income / Interest → pending, is_pre_tax, Male (account)', () => {
    const r = built({
      accountId: acc('ANZ Plus Male'),
      kind: 'income',
      amount: '8.50',
      date: '2026-09-30',
      categoryId: cat('Income / Interest'),
    });
    expect(r.transaction).toMatchObject({
      status: 'pending',
      amountCents: 850,
      date: '2026-09-30',
    });
    expect(r.split).toEqual({
      isPrimary: true,
      amountCents: 850,
      categoryId: cat('Income / Interest'),
      categorySource: 'manual',
      isPreTax: true,
      memberId: mem('Male'),
      memberSource: 'account',
    });
  });
});

describe('buildManualTransaction: fixed fields (R17.1)', () => {
  it('R17.1: no card, balance, dedupe key or batch; transfer none; source manual', () => {
    expect(built().transaction).toMatchObject({
      cardLast4: null,
      balanceCents: null,
      dedupeKey: null,
      importBatchId: null,
      transferStatus: 'none',
      source: 'manual',
    });
  });

  it('R17.1: does not run R6.1, a TRANSFER description stays a normal transaction', () => {
    const r = built({
      accountId: acc('ANZ Joint'),
      description: 'TRANSFER TO 012345400006691',
    });
    expect(r.transaction.transferStatus).toBe('none');
    expect(r.split.categoryId).toBe(UNCATEGORIZED);
  });
});

describe('buildManualTransaction: description (R17.1, R2.3, R3)', () => {
  it('R17.1: "coffee lab  " → raw_description "coffee lab", merchant "COFFEE LAB"', () => {
    const r = built({ description: 'coffee lab  ' });
    expect(r.transaction.rawDescription).toBe('coffee lab');
    expect(r.transaction.merchant).toBe('COFFEE LAB');
  });

  it('R2.3: 8+ consecutive digits are masked before storing', () => {
    const r = built({ description: 'paid 012345400006691' });
    expect(r.transaction.rawDescription).toBe('paid ****6691');
    expect(r.transaction.merchant).toBe('PAID ****6691');
  });

  it('R17.1: empty or whitespace-only description is an error', () => {
    expect(errors({ description: '   ' }).description).toBeDefined();
  });

  it('R17.1: 100 characters is fine, 101 is an error', () => {
    expect(built({ description: 'a'.repeat(100) }).transaction.rawDescription).toHaveLength(100);
    expect(errors({ description: 'a'.repeat(101) }).description).toBeDefined();
  });
});

describe('buildManualTransaction: amount (R17.1)', () => {
  it('R17.1: "12.5" expense → -1250', () => {
    expect(built({ amount: '12.5' }).transaction.amountCents).toBe(-1250);
  });

  it('R17.1: "12.5" income → +1250', () => {
    expect(built({ amount: '12.5', kind: 'income' }).transaction.amountCents).toBe(1250);
  });

  it('R15.1: primary split amount equals the transaction amount', () => {
    expect(built({ amount: '12.5' }).split.amountCents).toBe(-1250);
  });

  it.each(['0', '-5', '1.234', '', '  ', 'abc', '+5'])(
    'R17.1: amount "%s" is an error',
    (amount) => {
      expect(errors({ amount }).amount).toBeDefined();
    },
  );
});

describe('buildManualTransaction: date (R17.1)', () => {
  it('R17.1: today and any past date are fine', () => {
    expect(built({ date: TODAY }).transaction.date).toBe(TODAY);
    expect(built({ date: '2020-01-01' }).transaction.date).toBe('2020-01-01');
  });

  it('R17.1: a date after today is an error', () => {
    expect(errors({ date: '2026-10-27' }).date).toBeDefined();
  });

  it.each(['2026-02-30', '26/10/2026', '', '2026-1-1'])(
    'R17.1: invalid date "%s" is an error',
    (date) => {
      expect(errors({ date }).date).toBeDefined();
    },
  );
});

describe('buildManualTransaction: account, category, member checks', () => {
  it('R17.1: unknown account is an error', () => {
    expect(errors({ accountId: 'account:nope' }).accountId).toBeDefined();
  });

  it('R17.1: archived account is an error', () => {
    const archived = { ...cash, id: 'account:Old', isArchived: true };
    const c = { ...ctx, accounts: [...ctx.accounts, archived] };
    expect(errors({ accountId: archived.id }, c).accountId).toBeDefined();
  });

  it('R17.1: expense with an income category is an error', () => {
    expect(errors({ categoryId: cat('Income / Interest') }).categoryId).toBeDefined();
  });

  it('R17.1: income with an expense category is an error', () => {
    expect(
      errors({ kind: 'income', categoryId: cat('Groceries / Supermarket') }).categoryId,
    ).toBeDefined();
  });

  it('R17.1: expense can pick Cash withdrawal and Bank fees', () => {
    expect(built({ categoryId: CASH_WITHDRAWAL }).split.categoryId).toBe(CASH_WITHDRAWAL);
    expect(built({ categoryId: BANK_FEE }).split.categoryId).toBe(BANK_FEE);
  });

  it('R17.1: income cannot pick Cash withdrawal', () => {
    expect(errors({ kind: 'income', categoryId: CASH_WITHDRAWAL }).categoryId).toBeDefined();
  });

  it('R16.3: Internal transfer cannot be picked', () => {
    expect(errors({ categoryId: INTERNAL }).categoryId).toBeDefined();
  });

  it('R16.3: Uncategorised is "no category", not a pickable id', () => {
    expect(errors({ categoryId: UNCATEGORIZED }).categoryId).toBeDefined();
  });

  it('R16.3: child of an archived top-level category cannot be picked', () => {
    const categories = h.categories.map((c) =>
      c.id === cat('Groceries') ? { ...c, isArchived: true } : c,
    );
    const c = { ...ctx, categories };
    expect(errors({ categoryId: cat('Groceries / Supermarket') }, c).categoryId).toBeDefined();
  });

  it('unknown member is an error', () => {
    expect(errors({ memberId: 'member:nope' }).memberId).toBeDefined();
  });

  it('collects several field errors at once', () => {
    const e = errors({ amount: '0', description: '', date: '2026-12-01' });
    expect(Object.keys(e).sort()).toEqual(['amount', 'date', 'description']);
  });
});

describe('buildManualTransaction: sources (R17.3)', () => {
  it('R17.3 row 1: guessed category kept as is → category_source rule', () => {
    const r = built({
      description: 'COLES 0559',
      categoryId: cat('Groceries / Supermarket'),
      categoryGuessed: true,
    });
    expect(r.split.categorySource).toBe('rule');
  });

  it('R17.3 row 2: user picked the category → category_source manual', () => {
    const r = built({
      description: 'COLES 0559',
      categoryId: cat('Groceries / Supermarket'),
    });
    expect(r.split.categorySource).toBe('manual');
  });

  it('R17.3 row 3: no category → Uncategorised, category_source system', () => {
    const r = built({ categoryId: null });
    expect(r.split).toMatchObject({
      categoryId: UNCATEGORIZED,
      categorySource: 'system',
      isPreTax: false,
    });
  });

  it('R17.3 row 4a: member auto with a category default → category', () => {
    const r = built({
      accountId: acc('ANZ Male'),
      categoryId: cat('Groceries / Supermarket'),
    });
    expect(r.split).toMatchObject({
      memberId: mem('Home'),
      memberSource: 'category',
    });
  });

  it('R17.3 row 4b: member auto without a category default → account (no card number)', () => {
    const r = built({
      accountId: acc('ANZ Male'),
      categoryId: cat('Entertainment & eat-out / Restaurants'),
    });
    expect(r.split).toMatchObject({
      memberId: mem('Male'),
      memberSource: 'account',
    });
  });

  it('R17.3 row 5: user picked the member → manual', () => {
    const r = built({
      accountId: acc('ANZ Joint'),
      categoryId: cat('Groceries / Supermarket'),
      memberId: mem('Female'),
    });
    expect(r.split).toMatchObject({
      memberId: mem('Female'),
      memberSource: 'manual',
    });
  });

  it('R17.3: Joint + Groceries / Supermarket + member auto → Home (category)', () => {
    const r = built({
      accountId: acc('ANZ Joint'),
      description: 'COLES',
      categoryId: cat('Groceries / Supermarket'),
      categoryGuessed: true,
    });
    expect(r.split).toMatchObject({
      memberId: mem('Home'),
      memberSource: 'category',
      categorySource: 'rule',
    });
  });

  it('R17.3 + R7: guessed system-rule category (ATM) kept → category_source system', () => {
    const r = built({
      description: 'ATM CITY',
      categoryId: CASH_WITHDRAWAL,
      categoryGuessed: true,
    });
    expect(r.split.categorySource).toBe('system');
  });

  it('R17.3: categoryGuessed but the description does not guess that category → manual', () => {
    const r = built({
      description: 'Coffee Lab',
      categoryId: cat('Groceries / Supermarket'),
      categoryGuessed: true,
    });
    expect(r.split.categorySource).toBe('manual');
  });
});

// ---------- guessCategory ----------

describe('guessCategory (R17.2)', () => {
  it('R17.2: description containing COLES → Groceries / Supermarket (rule)', () => {
    expect(guessCategory('coles 0559 melbourne', 'expense', h.rules, h.categories)).toEqual({
      categoryId: cat('Groceries / Supermarket'),
      categorySource: 'rule',
    });
  });

  it('R17.2: same description with the toggle on income → no guess', () => {
    expect(guessCategory('coles 0559 melbourne', 'income', h.rules, h.categories)).toBeNull();
  });

  it('R17.2: system rule ATM → Cash withdrawal (system) on expense', () => {
    expect(guessCategory('ATM CITY', 'expense', h.rules, h.categories)).toEqual({
      categoryId: CASH_WITHDRAWAL,
      categorySource: 'system',
    });
  });

  it('R17.2: no rule hits → null, not Uncategorised', () => {
    expect(guessCategory('Qwzx Pty', 'expense', h.rules, h.categories)).toBeNull();
  });

  it('R17.2: empty description → null', () => {
    expect(guessCategory('   ', 'expense', h.rules, h.categories)).toBeNull();
  });

  it('R16.3: guessed category that is archived → null', () => {
    const categories = h.categories.map((c) =>
      c.id === cat('Groceries / Supermarket') ? { ...c, isArchived: true } : c,
    );
    expect(guessCategory('COLES', 'expense', h.rules, categories)).toBeNull();
  });
});

// ---------- frequentCategories ----------

describe('frequentCategories (R17.2)', () => {
  const use = (
    categoryId: string,
    date: string,
    createdAt = `${date}T01:00:00Z`,
  ): RecentManualUse => ({
    categoryId,
    categoryType: 'expense',
    date,
    createdAt: new Date(createdAt),
  });
  const coffee = cat('Entertainment & eat-out / Coffee & tea');
  const lunches = cat('Entertainment & eat-out / Lunches');
  const groceries = cat('Groceries / Supermarket');
  const bakery = cat('Entertainment & eat-out / Bakery');
  const drinks = cat('Entertainment & eat-out / Drinks');

  it('R17.2: sorted by count, most first', () => {
    const recent = [
      use(lunches, '2026-10-20'),
      use(coffee, '2026-10-01'),
      use(coffee, '2026-10-02'),
    ];
    expect(frequentCategories(recent, 'expense', TODAY, 4)).toEqual([coffee, lunches]);
  });

  it('R17.2: exactly 90 days ago counts, 91 days ago does not', () => {
    const recent = [use(coffee, '2026-07-28'), use(lunches, '2026-07-27')];
    expect(frequentCategories(recent, 'expense', TODAY, 4)).toEqual([coffee]);
  });

  it('R17.2: same count → the most recently used first', () => {
    const recent = [
      use(coffee, '2026-10-01'),
      use(lunches, '2026-10-20'),
      use(groceries, '2026-10-10'),
    ];
    expect(frequentCategories(recent, 'expense', TODAY, 4)).toEqual([lunches, groceries, coffee]);
  });

  it('R17.2: same count and same date → later created_at first', () => {
    const recent = [
      use(coffee, '2026-10-20', '2026-10-20T01:00:00Z'),
      use(lunches, '2026-10-20', '2026-10-20T05:00:00Z'),
    ];
    expect(frequentCategories(recent, 'expense', TODAY, 4)).toEqual([lunches, coffee]);
  });

  it('R17.2: only categories of the current toggle type', () => {
    const interest: RecentManualUse = {
      ...use(cat('Income / Interest'), '2026-10-20'),
      categoryType: 'income',
    };
    const recent = [use(coffee, '2026-10-01'), interest];
    expect(frequentCategories(recent, 'expense', TODAY, 4)).toEqual([coffee]);
    expect(frequentCategories(recent, 'income', TODAY, 4)).toEqual([cat('Income / Interest')]);
  });

  it('R17.2: Uncategorised and Internal transfer are never shown', () => {
    const recent: RecentManualUse[] = [
      { ...use(UNCATEGORIZED, '2026-10-20'), categoryType: 'uncategorized' },
      { ...use(INTERNAL, '2026-10-20'), categoryType: 'internal_transfer' },
    ];
    expect(frequentCategories(recent, 'expense', TODAY, 4)).toEqual([]);
  });

  it('R17.2: top n only; fewer than n is not padded', () => {
    const ids = [coffee, lunches, groceries, bakery, drinks];
    // coffee 5 次、lunches 4 次 …… drinks 1 次
    const recent = ids.flatMap((id, i) =>
      Array.from({ length: 5 - i }, () => use(id, '2026-10-20')),
    );
    expect(frequentCategories(recent, 'expense', TODAY, 4)).toEqual(ids.slice(0, 4));
    expect(frequentCategories([use(coffee, '2026-10-20')], 'expense', TODAY, 4)).toEqual([coffee]);
  });
});

// ---------- canEditManual ----------

describe('canEditManual (R17.5)', () => {
  const base = {
    source: 'manual' as const,
    importBatchId: null,
    transferPairId: null,
  };

  it('R17.5: manual, not imported, no pair → can edit and delete', () => {
    expect(canEditManual(base)).toEqual({
      canEdit: true,
      canDelete: true,
      reason: null,
    });
  });

  it('R17.5: pending confirmed by an import (import_batch_id set) → no edit, no delete', () => {
    const r = canEditManual({ ...base, importBatchId: 'batch:1' });
    expect(r).toMatchObject({ canEdit: false, canDelete: false });
    expect(r.reason).toBeTruthy();
  });

  it('R17.5: imported transaction (source csv) → no edit, no delete', () => {
    const r = canEditManual({
      ...base,
      source: 'csv',
      importBatchId: 'batch:1',
    });
    expect(r).toMatchObject({ canEdit: false, canDelete: false });
    expect(r.reason).toBeTruthy();
  });

  it('R17.5: receipt-created (source receipt), not imported → can edit and delete like manual (R20.7)', () => {
    expect(canEditManual({ ...base, source: 'receipt' })).toEqual({
      canEdit: true,
      canDelete: true,
      reason: null,
    });
  });

  it('R17.5: receipt-created but confirmed by an import → no edit, no delete', () => {
    const r = canEditManual({ ...base, source: 'receipt', importBatchId: 'batch:1' });
    expect(r).toMatchObject({ canEdit: false, canDelete: false });
    expect(r.reason).toBeTruthy();
  });

  it('R17.5: has transfer_pair_id → can edit, cannot delete', () => {
    const r = canEditManual({ ...base, transferPairId: 'tx:9' });
    expect(r).toMatchObject({ canEdit: true, canDelete: false });
    expect(r.reason).toBeTruthy();
  });
});

// ---------- applyManualEdit ----------

describe('applyManualEdit (R17.5)', () => {
  // 现金账户上的 Coffee Lab -12.50，Coffee & tea（manual），Home（account）
  function cashTx(over: Partial<ManualEditTx> = {}): ManualEditTx {
    return {
      source: 'manual',
      importBatchId: null,
      transferPairId: null,
      accountId: cash.id,
      date: '2026-10-20',
      amountCents: -1250,
      rawDescription: 'Coffee Lab',
      merchant: 'COFFEE LAB',
      status: 'confirmed',
      ...over,
    };
  }
  const primary = (over: Partial<ManualSplit> = {}): ManualSplit => ({
    id: 'split:1',
    isPrimary: true,
    amountCents: -1250,
    categoryId: cat('Entertainment & eat-out / Coffee & tea'),
    categorySource: 'manual',
    memberId: mem('Home'),
    memberSource: 'account',
    ...over,
  });
  const twoSplits = (): ManualSplit[] => [
    primary({ amountCents: -1000 }),
    primary({ id: 'split:2', isPrimary: false, amountCents: -250 }),
  ];

  function ok(r: ReturnType<typeof applyManualEdit>) {
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r;
  }

  it('R17.5: has import_batch_id → cannot edit', () => {
    const r = applyManualEdit(
      cashTx({ importBatchId: 'batch:1' }),
      [primary()],
      { date: '2026-10-19' },
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it('R17.5: change amount with only the primary split → transaction and primary follow, sign kept', () => {
    const r = ok(applyManualEdit(cashTx(), [primary()], { amount: '20' }, ctx));
    expect(r.transaction).toEqual({ amountCents: -2000 });
    expect(r.splits).toEqual([{ id: 'split:1', amountCents: -2000 }]);
  });

  it('R17.5: income stays positive when the amount changes', () => {
    const r = ok(
      applyManualEdit(
        cashTx({ amountCents: 850 }),
        [primary({ amountCents: 850 })],
        { amount: '9' },
        ctx,
      ),
    );
    expect(r.transaction).toEqual({ amountCents: 900 });
  });

  it('R17.5: two splits and the amount changes → error', () => {
    const r = applyManualEdit(cashTx(), twoSplits(), { amount: '20' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.amount).toBeDefined();
  });

  it('R17.5: two splits, amount unchanged → not an error', () => {
    const r = applyManualEdit(cashTx(), twoSplits(), { amount: '12.50', date: '2026-10-19' }, ctx);
    expect(ok(r).transaction).toEqual({ date: '2026-10-19' });
  });

  it('R17.5: changing the sign (expense → income) → error', () => {
    expect(applyManualEdit(cashTx(), [primary()], { kind: 'income' }, ctx).ok).toBe(false);
  });

  it.each(['0', '-5', '1.234', ''])('R17.5: invalid amount "%s" → error', (amount) => {
    expect(applyManualEdit(cashTx(), [primary()], { amount }, ctx).ok).toBe(false);
  });

  it('R17.5: date after today → error', () => {
    expect(applyManualEdit(cashTx(), [primary()], { date: '2026-10-27' }, ctx).ok).toBe(false);
  });

  it('R17.5: change description → merchant re-cleaned, category not re-guessed', () => {
    const r = ok(applyManualEdit(cashTx(), [primary()], { description: '  coles 0559 ' }, ctx));
    expect(r.transaction).toEqual({
      rawDescription: 'coles 0559',
      merchant: 'COLES 0559',
    });
    expect(r.splits).toEqual([]);
  });

  it('R17.5: empty description → error', () => {
    expect(applyManualEdit(cashTx(), [primary()], { description: '  ' }, ctx).ok).toBe(false);
  });

  it('R17.5: cash → ANZ Joint becomes pending', () => {
    const r = ok(applyManualEdit(cashTx(), [primary()], { accountId: acc('ANZ Joint') }, ctx));
    expect(r.transaction).toEqual({
      accountId: acc('ANZ Joint'),
      status: 'pending',
    });
    // Coffee & tea 没有分类默认，Joint 默认也是 Home → 归属人没变
    expect(r.splits).toEqual([]);
  });

  it('R17.5: ANZ Joint → cash becomes confirmed', () => {
    const r = ok(
      applyManualEdit(
        cashTx({ accountId: acc('ANZ Joint'), status: 'pending' }),
        [primary()],
        { accountId: cash.id },
        ctx,
      ),
    );
    expect(r.transaction).toEqual({ accountId: cash.id, status: 'confirmed' });
  });

  it('R17.5: change account to ANZ Male → member (account) becomes Male', () => {
    const r = ok(applyManualEdit(cashTx(), [primary()], { accountId: acc('ANZ Male') }, ctx));
    expect(r.transaction).toEqual({
      accountId: acc('ANZ Male'),
      status: 'pending',
    });
    expect(r.splits).toEqual([{ id: 'split:1', memberId: mem('Male'), memberSource: 'account' }]);
  });

  it('R17.5: change account → manual member is not touched', () => {
    const r = ok(
      applyManualEdit(
        cashTx(),
        [primary({ memberId: mem('Female'), memberSource: 'manual' })],
        { accountId: acc('ANZ Male') },
        ctx,
      ),
    );
    expect(r.splits).toEqual([]);
  });

  it('R17.5: change account → category default still wins over the account', () => {
    const r = ok(
      applyManualEdit(
        cashTx(),
        [
          primary({
            categoryId: cat('Groceries / Supermarket'),
            memberSource: 'category',
          }),
        ],
        { accountId: acc('ANZ Male') },
        ctx,
      ),
    );
    expect(r.splits).toEqual([]);
  });

  it('R17.5: change account → every non-manual split is recomputed', () => {
    const splits = [
      primary({ amountCents: -1000 }),
      primary({
        id: 'split:2',
        isPrimary: false,
        amountCents: -250,
        memberId: mem('Female'),
        memberSource: 'manual',
      }),
    ];
    const r = ok(applyManualEdit(cashTx(), splits, { accountId: acc('ANZ Male') }, ctx));
    expect(r.splits).toEqual([{ id: 'split:1', memberId: mem('Male'), memberSource: 'account' }]);
  });

  it('R17.5: unknown account → error', () => {
    expect(applyManualEdit(cashTx(), [primary()], { accountId: 'account:nope' }, ctx).ok).toBe(
      false,
    );
  });

  it('R17.5: same values → no changes', () => {
    const r = ok(
      applyManualEdit(
        cashTx(),
        [primary()],
        {
          date: '2026-10-20',
          amount: '12.5',
          accountId: cash.id,
          description: 'Coffee Lab',
        },
        ctx,
      ),
    );
    expect(r.transaction).toEqual({});
    expect(r.splits).toEqual([]);
  });
});

// ---------- activeDuplicates ----------

describe('activeDuplicates (R17.6)', () => {
  // 导入 joint 后：#12 有两个候选 P3、P4
  const warnings = [{ transactionId: 'tx:12', pendingIds: ['tx:P3', 'tx:P4'] }];
  const sorted = (ids: string[]) => [...ids].sort();

  it('R17.6 step 1: after importing joint, #12, P3 and P4 are all possible duplicates', () => {
    const states = new Map([
      ['tx:P3', 'pending' as const],
      ['tx:P4', 'pending' as const],
    ]);
    expect(sorted(activeDuplicates(warnings, states))).toEqual(['tx:12', 'tx:P3', 'tx:P4']);
  });

  it('R17.6 step 2: delete P4 → P3 and #12 still shown', () => {
    const states = new Map([['tx:P3', 'pending' as const]]);
    expect(sorted(activeDuplicates(warnings, states))).toEqual(['tx:12', 'tx:P3']);
  });

  it('R17.6 step 3: then delete P3 → nothing shown', () => {
    expect(activeDuplicates(warnings, new Map())).toEqual([]);
  });

  it('R17.6: pendings that are no longer pending do not count', () => {
    const states = new Map([
      ['tx:P3', 'confirmed' as const],
      ['tx:P4', 'confirmed' as const],
    ]);
    expect(activeDuplicates(warnings, states)).toEqual([]);
  });

  it('R17.6: no warnings → nothing', () => {
    expect(activeDuplicates([], new Map())).toEqual([]);
  });

  it('R17.6: an id in several records appears once', () => {
    const w = [...warnings, { transactionId: 'tx:13', pendingIds: ['tx:P3'] }];
    const states = new Map([['tx:P3', 'pending' as const]]);
    expect(sorted(activeDuplicates(w, states))).toEqual(['tx:12', 'tx:13', 'tx:P3']);
  });
});
