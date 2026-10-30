import { describe, expect, it } from 'vitest';
import { processFile } from '@/lib/import/process';
import { readFixture, readReceiptFixture } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import type { ManualAccount, ManualContext } from './manual';
import { normalizeReceipt, rawReceiptSchema, type NormalizedReceipt } from './receipt';
import {
  buildReceiptTransaction,
  defaultReceiptAccount,
  findReceiptCandidates,
  needsOverwriteConfirm,
  type ReceiptCandidateTx,
} from './receipt-match';
import type { Card } from './types';

// 期望值来自 business-rules.md R20.4、R20.5、R20.6、R8.1、R20.8（R-A、R-E）
// 和 fixtures/README.md "小票用例"

const h = buildTestHousehold();
const joint = h.account('ANZ Joint');
const male = h.account('ANZ Male');
const cat = (path: string) => h.category(path).id;
const mem = (name: string) => h.member(name).id;

const CATEGORIES = h.categories
  .filter((c) => c.parentId !== null && c.kind === 'expense')
  .map((c) => ({ id: c.id, label: c.id.slice('category:'.length) }));

function fixture(name: `${string}.json`): NormalizedReceipt {
  const raw = rawReceiptSchema.parse(readReceiptFixture(name));
  return normalizeReceipt(raw, CATEGORIES, '2026-10-29').receipt;
}

// coles-a：COLES，2026-08-31，总额 58.40，卡 1111
const COLES_A = fixture('coles-a.json');

// 默认是一笔能匹配 coles-a 的交易
function tx(over: Partial<ReceiptCandidateTx> = {}): ReceiptCandidateTx {
  return {
    id: 'tx',
    accountId: joint.id,
    date: '2026-09-01',
    amountCents: -5840,
    cardLast4: null,
    merchant: 'SOMEWHERE',
    status: 'confirmed',
    transferStatus: 'none',
    hasReceipt: false,
    ...over,
  };
}

const ids = (r: { candidates: ReceiptCandidateTx[] }) => r.candidates.map((c) => c.id);
const find = (
  cardLast4: string | null,
  txs: ReceiptCandidateTx[],
  cards: readonly Card[] = h.cards,
) => findReceiptCandidates(COLES_A, cardLast4, txs, cards);

// ---------- R20.4 ----------

describe('R20.4 findReceiptCandidates', () => {
  it('R-A: after importing joint-2026-09.csv the only candidate is #19, selected by default', () => {
    const result = processFile(readFixture('anz/joint-2026-09.csv'), joint, h);
    if (!result.ok) throw new Error(result.message);
    const txs = result.rows.map((row, i): ReceiptCandidateTx => ({
      id: `#${i + 1}`,
      accountId: row.accountId,
      date: row.date,
      amountCents: row.amountCents,
      cardLast4: row.cardLast4,
      merchant: row.merchant,
      status: 'confirmed',
      transferStatus: row.transferStatus,
      hasReceipt: false,
    }));
    const r = findReceiptCandidates(COLES_A, '1111', txs, h.cards);
    expect(ids(r)).toEqual(['#19']);
    expect(r.defaultId).toBe('#19');

    // R-A'：#19 挂上小票以后，再传一次就没有候选
    const attached = txs.map((t) => (t.id === '#19' ? { ...t, hasReceipt: true } : t));
    expect(findReceiptCandidates(COLES_A, '1111', attached, h.cards)).toEqual({
      candidates: [],
      defaultId: null,
    });
  });

  it('R20.4: amount must equal minus the total', () => {
    const r = find(null, [
      tx({ id: 'ok' }),
      tx({ id: 'off-by-one', amountCents: -5841 }),
      tx({ id: 'income', amountCents: 5840 }),
    ]);
    expect(ids(r)).toEqual(['ok']);
  });

  it('R20.4: transaction date − receipt date must be 0 to 3 days', () => {
    const r = find(null, [
      tx({ id: '-1', date: '2026-08-30' }),
      tx({ id: '0', date: '2026-08-31' }),
      tx({ id: '3', date: '2026-09-03' }),
      tx({ id: '4', date: '2026-09-04' }),
    ]);
    expect(ids(r)).toEqual(['0', '3']);
  });

  it('R20.4: only transfer_status none; auto, suggested and confirmed are skipped', () => {
    const r = find(null, [
      tx({ id: 'none' }),
      tx({ id: 'auto', transferStatus: 'auto' }),
      tx({ id: 'suggested', transferStatus: 'suggested' }),
      tx({ id: 'confirmed', transferStatus: 'confirmed' }),
    ]);
    expect(ids(r)).toEqual(['none']);
  });

  it('R20.4: transactions that already have a receipt are skipped', () => {
    expect(ids(find(null, [tx({ id: 'free' }), tx({ id: 'taken', hasReceipt: true })]))).toEqual([
      'free',
    ]);
  });

  it('R20.4: pending and confirmed both count', () => {
    const r = find(null, [tx({ id: 'p', status: 'pending' }), tx({ id: 'c' })]);
    expect(ids(r).sort()).toEqual(['c', 'p']);
  });

  it('R20.4: card 1111 is in the card table → only ANZ Joint, and card_last4 must match when set', () => {
    const r = find('1111', [
      tx({ id: 'joint-1111', cardLast4: '1111' }),
      tx({ id: 'joint-no-card', cardLast4: null }),
      tx({ id: 'joint-2222', cardLast4: '2222' }),
      tx({ id: 'male-account', accountId: male.id }),
    ]);
    expect(ids(r)).toEqual(['joint-1111', 'joint-no-card']);
  });

  it('R20.4: card 9999 is not in the card table → no card filter', () => {
    const r = find('9999', [
      tx({ id: 'joint-2222', cardLast4: '2222' }),
      tx({ id: 'male-account', accountId: male.id }),
    ]);
    expect(ids(r).sort()).toEqual(['joint-2222', 'male-account']);
  });

  it('R20.4: no card on the receipt → no card filter', () => {
    const r = find(null, [tx({ id: 'a', cardLast4: '2222' }), tx({ id: 'b', accountId: male.id })]);
    expect(ids(r).sort()).toEqual(['a', 'b']);
  });

  it('R20.4: sort by same card, then merchant keyword, then smaller date gap', () => {
    const r = find('1111', [
      tx({ id: 'plain-2', date: '2026-09-02' }),
      tx({ id: 'plain-0', date: '2026-08-31' }),
      tx({ id: 'keyword', date: '2026-09-03', merchant: 'coles 0559 melbourne' }),
      tx({ id: 'card', date: '2026-09-03', cardLast4: '1111' }),
      tx({ id: 'card-keyword', date: '2026-09-03', cardLast4: '1111', merchant: 'COLES 0559' }),
    ]);
    expect(ids(r)).toEqual(['card-keyword', 'card', 'keyword', 'plain-0', 'plain-2']);
  });

  it('R20.4: two or more candidates → nothing selected by default', () => {
    const r = find(null, [tx({ id: 'a' }), tx({ id: 'b', date: '2026-09-02' })]);
    expect(ids(r)).toEqual(['a', 'b']);
    expect(r.defaultId).toBeNull();
  });

  it('R-E: no candidates → nothing selected', () => {
    const r = findReceiptCandidates(fixture('coles-e.json'), '2222', [tx()], h.cards);
    expect(r).toEqual({ candidates: [], defaultId: null });
  });
});

// ---------- R20.5 默认账户 ----------

const cashA: ManualAccount = {
  id: 'account:Cash A',
  name: 'Cash A',
  bank: 'cash',
  type: 'cash',
  defaultMemberId: mem('Home'),
  numberSuffix: null,
};
const cashB: ManualAccount = { ...cashA, id: 'account:Cash B', name: 'Cash B' };
const ACCOUNTS: ManualAccount[] = [...h.accounts, cashA, cashB];

describe('R20.5 defaultReceiptAccount', () => {
  it('R-E: card 2222 is on ANZ Joint → ANZ Joint', () => {
    expect(defaultReceiptAccount('card', '2222', h.cards, ACCOUNTS, male.id)).toEqual({
      accountId: joint.id,
      cardAccountIds: [joint.id],
    });
  });

  it('R20.5: same last4 on several accounts → let the user choose', () => {
    const cards: Card[] = [
      ...h.cards,
      { id: 'card:male:1111', accountId: male.id, last4: '1111', memberId: mem('Male') },
    ];
    expect(defaultReceiptAccount('card', '1111', cards, ACCOUNTS, male.id)).toEqual({
      accountId: null,
      cardAccountIds: [joint.id, male.id],
    });
  });

  it('R20.5: card on an archived account is ignored', () => {
    const accounts = ACCOUNTS.map((a) => (a.id === joint.id ? { ...a, isArchived: true } : a));
    expect(defaultReceiptAccount('card', '2222', h.cards, accounts, male.id)).toEqual({
      accountId: male.id,
      cardAccountIds: [],
    });
  });

  it('R20.5: card without last4 or not in the table → last account (R17.2)', () => {
    expect(defaultReceiptAccount('card', null, h.cards, ACCOUNTS, male.id).accountId).toBe(male.id);
    expect(defaultReceiptAccount('card', '9999', h.cards, ACCOUNTS, male.id).accountId).toBe(
      male.id,
    );
    expect(defaultReceiptAccount('card', '9999', h.cards, ACCOUNTS, null).accountId).toBeNull();
  });

  it('R20.5: cash → first cash account that is not archived', () => {
    expect(defaultReceiptAccount('cash', null, h.cards, ACCOUNTS, male.id).accountId).toBe(
      cashA.id,
    );
    const archivedA = ACCOUNTS.map((a) => (a.id === cashA.id ? { ...a, isArchived: true } : a));
    expect(defaultReceiptAccount('cash', null, h.cards, archivedA, male.id).accountId).toBe(
      cashB.id,
    );
    expect(defaultReceiptAccount('cash', null, h.cards, h.accounts, male.id).accountId).toBeNull();
  });

  it('R20.5: cash ignores the card last4', () => {
    expect(defaultReceiptAccount('cash', '2222', h.cards, ACCOUNTS, male.id).accountId).toBe(
      cashA.id,
    );
  });

  it('R20.5: unknown → last account; archived or missing last account → none', () => {
    expect(defaultReceiptAccount('unknown', null, h.cards, ACCOUNTS, male.id).accountId).toBe(
      male.id,
    );
    const archived = ACCOUNTS.map((a) => (a.id === male.id ? { ...a, isArchived: true } : a));
    expect(defaultReceiptAccount('unknown', null, h.cards, archived, male.id).accountId).toBeNull();
    expect(
      defaultReceiptAccount('unknown', null, h.cards, ACCOUNTS, 'account:gone').accountId,
    ).toBeNull();
  });
});

// ---------- R20.5 新建交易 ----------

const ctx: ManualContext = {
  members: h.members,
  accounts: ACCOUNTS,
  cards: h.cards,
  categories: h.categories,
  rules: h.rules,
  today: '2026-10-29',
};

describe('R20.5 buildReceiptTransaction', () => {
  it('R-E: new ANZ Joint pending, source receipt, receipt date and total, card_last4 empty', () => {
    const r = buildReceiptTransaction(fixture('coles-e.json'), joint.id, ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.transaction).toEqual({
      accountId: joint.id,
      date: '2026-09-28',
      amountCents: -2345,
      rawDescription: 'COLES',
      merchant: 'COLES',
      status: 'pending',
      cardLast4: null,
      balanceCents: null,
      dedupeKey: null,
      importBatchId: null,
      transferStatus: 'none',
      source: 'receipt',
    });
    // merchant COLES 命中预置规则 → Groceries / Supermarket（rule），Home（category）
    expect(r.split).toEqual({
      isPrimary: true,
      amountCents: -2345,
      categoryId: cat('Groceries / Supermarket'),
      categorySource: 'rule',
      isPreTax: false,
      memberId: mem('Home'),
      memberSource: 'category',
    });
  });

  it('R8.1: cash accounts are confirmed', () => {
    const r = buildReceiptTransaction(fixture('coles-e.json'), cashA.id, ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.transaction.status).toBe('confirmed');
  });

  it('R8.1: ANZ Plus accounts are pending (R20.5)', () => {
    const r = buildReceiptTransaction(fixture('coles-e.json'), h.account('ANZ Plus Male').id, ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.transaction.status).toBe('pending');
  });

  it('R8.1: CBA is pending', () => {
    const r = buildReceiptTransaction(fixture('coles-e.json'), h.account('CBA Female').id, ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.transaction.status).toBe('pending');
  });

  it('R20.5: no rule hit → Uncategorised (system), member by R5 without card → account', () => {
    const r = buildReceiptTransaction(fixture('grocer-b.json'), male.id, ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.transaction).toMatchObject({
      merchant: 'SUNNY GROCER',
      date: '2026-09-25',
      amountCents: -3233,
      cardLast4: null,
    });
    expect(r.split).toMatchObject({
      categoryId: h.systemCategory('uncategorized').id,
      categorySource: 'system',
      memberId: mem('Male'),
      memberSource: 'account',
    });
  });

  it('R20.5: card_last4 stays empty even when the receipt has one', () => {
    const r = buildReceiptTransaction(COLES_A, joint.id, ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.transaction.cardLast4).toBeNull();
    expect(r.transaction.amountCents).toBe(-5840);
  });

  it('R17.1: archived or unknown account is a field error', () => {
    const archived = { ...ctx, accounts: ACCOUNTS.map((a) => ({ ...a, isArchived: true })) };
    const r = buildReceiptTransaction(COLES_A, joint.id, archived);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.accountId).toBeTruthy();
  });

  it('R20.5: receipt must have a date and a positive total', () => {
    expect(() => buildReceiptTransaction({ ...COLES_A, date: null }, joint.id, ctx)).toThrow();
    expect(() => buildReceiptTransaction({ ...COLES_A, totalCents: 0 }, joint.id, ctx)).toThrow();
  });
});

// ---------- R20.6 ----------

describe('R20.6 needsOverwriteConfirm', () => {
  const primary = { isPrimary: true, categorySource: 'rule' as const };
  const other = { isPrimary: false, categorySource: 'manual' as const };

  it('R20.6: one primary split from a rule → no confirm', () => {
    expect(needsOverwriteConfirm([primary])).toEqual({
      needed: false,
      splitCount: 1,
      manualCategory: false,
    });
  });

  it('R20.6: several splits → confirm', () => {
    expect(needsOverwriteConfirm([primary, other])).toEqual({
      needed: true,
      splitCount: 2,
      manualCategory: false,
    });
  });

  it('R20.6: primary category_source manual → confirm', () => {
    expect(needsOverwriteConfirm([{ isPrimary: true, categorySource: 'manual' }])).toEqual({
      needed: true,
      splitCount: 1,
      manualCategory: true,
    });
  });

  it('R20.6: two splits and a manual primary → confirm, both reported', () => {
    expect(needsOverwriteConfirm([other, { isPrimary: true, categorySource: 'manual' }])).toEqual({
      needed: true,
      splitCount: 2,
      manualCategory: true,
    });
  });

  it('R20.6: system category on the primary does not need confirm', () => {
    expect(needsOverwriteConfirm([{ isPrimary: true, categorySource: 'system' }]).needed).toBe(
      false,
    );
  });
});
