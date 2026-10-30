import { describe, expect, it } from 'vitest';
import { parseAnzPlusStatement } from '@/lib/import/anz-plus-statement';
import { processFile } from '@/lib/import/process';
import { readAnzPlusStatementFixture, readFixture } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import {
  confirmPendingTransfer,
  findPendingMatches,
  initialStatus,
  isMatchCandidate,
  type PendingTx,
} from './pending';

// 期望值来自 business-rules.md R8.1、R8.2 和 fixtures/cases/06-pending.md
// 只测找候选，确认动作（R8.3）在 M3 的事务里做

const h = buildTestHousehold();
const joint = h.account('ANZ Joint');

describe('initialStatus（R8.1）', () => {
  it('R8.1 P7: ANZ Plus can import PDF statements → pending', () => {
    expect(initialStatus(h.account('ANZ Plus Male'))).toBe('pending');
  });

  it('R8.1 P8: CBA has a parser → pending', () => {
    expect(initialStatus(h.account('CBA Female'))).toBe('pending');
  });

  it('R8.1: anz → pending; cash and other → confirmed', () => {
    expect(initialStatus(joint)).toBe('pending');
    expect(initialStatus({ ...joint, bank: 'cash' })).toBe('confirmed');
    expect(initialStatus({ ...joint, bank: 'other' })).toBe('confirmed');
  });
});

describe('findPendingMatches：P1 到 P6 + joint-2026-09.csv（R8.2）', () => {
  const result = processFile(readFixture('anz/joint-2026-09.csv'), joint, h);
  if (!result.ok) throw new Error(result.message);
  const rows = result.rows;

  const pending = (id: string, amountCents: number, date: string): PendingTx => ({
    id,
    accountId: joint.id,
    date,
    amountCents,
  });
  const PENDINGS = [
    pending('P1', -6120, '2026-09-20'),
    pending('P2', -3875, '2026-09-20'),
    pending('P3', -2500, '2026-09-11'),
    pending('P4', -2500, '2026-09-12'),
    pending('P5', -1000, '2026-09-05'),
    pending('P6', -5840, '2026-09-02'),
  ];

  const matches = findPendingMatches(rows, joint.id, PENDINGS);

  it('R8.2 P1: #8 matches (2 days later)', () => {
    expect(matches[7]).toEqual({ kind: 'match', pendingId: 'P1' });
  });

  it('R8.2 P2: #9 matches (same day)', () => {
    expect(matches[8]).toEqual({ kind: 'match', pendingId: 'P2' });
  });

  it('R8.2 P3/P4: #12 has 2 candidates → insert as new, flag possible duplicate', () => {
    expect(matches[11]).toEqual({ kind: 'ambiguous', pendingIds: ['P3', 'P4'] });
  });

  it('R8.2 P6: #19 is earlier than the pending → no match', () => {
    expect(matches[18]).toEqual({ kind: 'none' });
  });

  it('R8.2: P5 and P6 are never matched', () => {
    const used = matches.flatMap((m) => (m.kind === 'match' ? [m.pendingId] : []));
    expect(used).toEqual(['P1', 'P2']);
  });

  it('R8.2: counts inserted 17, matched_pending 2', () => {
    expect(matches).toHaveLength(19);
    expect(matches.filter((m) => m.kind !== 'match')).toHaveLength(17);
    expect(matches.filter((m) => m.kind === 'match')).toHaveLength(2);
  });
});

describe('findPendingMatches：边界（R8.2）', () => {
  const p = (id: string, date: string, amountCents = -1000, accountId = joint.id): PendingTx => ({
    id,
    accountId,
    date,
    amountCents,
  });
  const row = (date: string, amountCents = -1000) => ({ date, amountCents });

  it.each([
    ['2026-09-10', 'match'],
    ['2026-09-11', 'match'],
    ['2026-09-13', 'match'], // 3 天
    ['2026-09-14', 'none'], // 4 天
    ['2026-09-09', 'none'], // 银行日期早于 pending
  ])('R8.2: bank date %s for pending on 09-10 → %s', (date, kind) => {
    expect(findPendingMatches([row(date)], joint.id, [p('A', '2026-09-10')])[0].kind).toBe(kind);
  });

  it('R8.2: amount must be exactly equal', () => {
    expect(
      findPendingMatches([row('2026-09-10', -1001)], joint.id, [p('A', '2026-09-10')]),
    ).toEqual([{ kind: 'none' }]);
  });

  it('R8.2: pendings in other accounts are ignored', () => {
    const other = p('A', '2026-09-10', -1000, h.account('CBA Female').id);
    expect(findPendingMatches([row('2026-09-10')], joint.id, [other])).toEqual([{ kind: 'none' }]);
  });

  it('R8.2: a pending taken by an earlier row is not offered to later rows', () => {
    const got = findPendingMatches([row('2026-09-11'), row('2026-09-12')], joint.id, [
      p('A', '2026-09-10'),
    ]);
    expect(got).toEqual([{ kind: 'match', pendingId: 'A' }, { kind: 'none' }]);
  });

  it('R8.2: an ambiguous row does not take its candidates', () => {
    const got = findPendingMatches([row('2026-09-11'), row('2026-09-12')], joint.id, [
      p('A', '2026-09-10'),
      p('B', '2026-09-11'),
    ]);
    expect(got).toEqual([
      { kind: 'ambiguous', pendingIds: ['A', 'B'] },
      { kind: 'ambiguous', pendingIds: ['A', 'B'] },
    ]);
  });
});

describe('confirmPendingTransfer：R8.3 例外，银行那行是内部转账', () => {
  const result = processFile(readFixture('anz/joint-2026-09.csv'), joint, h);
  if (!result.ok) throw new Error(result.message);
  const row = (n: number) => result.rows[n - 1];

  const INTERNAL = h.systemCategory('internal_transfer');
  const female = h.member('Female').id;
  const ctx = { categories: h.categories, cards: h.cards, accounts: h.accounts };

  it('R8.3 P10: #11 recognised by R6.1 → auto, primary split becomes internal transfer (system), manual member Female kept', () => {
    expect(row(11)).toMatchObject({ transferStatus: 'auto', date: '2026-09-15' });
    expect(
      confirmPendingTransfer(
        row(11),
        { splitCount: 1, primaryMember: { memberId: female, memberSource: 'manual' } },
        ctx,
      ),
    ).toEqual({
      kind: 'transfer',
      transferStatus: 'auto',
      transferAccountId: h.account('CBA Female').id,
      primarySplit: {
        categoryId: INTERNAL.id,
        categorySource: 'system',
        isPreTax: INTERNAL.isPreTaxDefault,
        memberId: female,
        memberSource: 'manual',
      },
    });
  });

  it('R8.3: member that is not manual is recomputed by R5.1 (internal transfer has no default → account)', () => {
    const got = confirmPendingTransfer(
      row(11),
      { splitCount: 1, primaryMember: { memberId: female, memberSource: 'category' } },
      ctx,
    );
    expect(got.kind === 'transfer' && got.primarySplit).toMatchObject({
      memberId: h.member('Home').id,
      memberSource: 'account',
    });
  });

  it('R8.3: pending with several splits → nothing changes, F8 needs a hint', () => {
    expect(
      confirmPendingTransfer(
        row(11),
        { splitCount: 2, primaryMember: { memberId: female, memberSource: 'manual' } },
        ctx,
      ),
    ).toEqual({ kind: 'multiple_splits', transferAccountId: h.account('CBA Female').id });
  });

  it('R8.3: bank row that is not an internal transfer (P1 → #8, #18 external account) → keep the pending as is', () => {
    const pending = {
      splitCount: 1,
      primaryMember: { memberId: female, memberSource: 'manual' as const },
    };
    expect(confirmPendingTransfer(row(8), pending, ctx)).toEqual({ kind: 'not_transfer' });
    expect(confirmPendingTransfer(row(18), pending, ctx)).toEqual({ kind: 'not_transfer' });
  });
});

describe('isMatchCandidate：R8.2 候选，P11 到 P14', () => {
  const anzPlus = h.account('ANZ Plus Male');
  const legacy = { status: 'confirmed', source: 'manual', importBatchId: null } as const;

  it('R8.2: every pending is a candidate, whatever the bank or source', () => {
    for (const bank of ['anz', 'cba', 'anz_plus'] as const) {
      expect(isMatchCandidate({ ...legacy, status: 'pending' }, { bank })).toBe(true);
    }
    expect(
      isMatchCandidate({ status: 'pending', source: 'receipt', importBatchId: null }, anzPlus),
    ).toBe(true);
  });

  it('R8.2 P11: ANZ Plus confirmed manual tx with no import batch → candidate', () => {
    expect(isMatchCandidate(legacy, anzPlus)).toBe(true);
  });

  it('R8.2 P12: ANZ Plus confirmed manual tx already confirmed by an import → not a candidate', () => {
    expect(isMatchCandidate({ ...legacy, importBatchId: 'batch:1' }, anzPlus)).toBe(false);
  });

  it('R8.2 P13: ANZ and CBA confirmed manual txs are not candidates', () => {
    expect(isMatchCandidate(legacy, joint)).toBe(false);
    expect(isMatchCandidate(legacy, h.account('CBA Female'))).toBe(false);
  });

  it('R8.2 P14: ANZ Plus confirmed receipt tx → not a candidate (only source = manual)', () => {
    expect(isMatchCandidate({ ...legacy, source: 'receipt' }, anzPlus)).toBe(false);
  });

  it('R8.2: ANZ Plus confirmed imported tx (source csv) → not a candidate', () => {
    expect(isMatchCandidate({ ...legacy, source: 'csv' }, anzPlus)).toBe(false);
  });

  it('R8.2 P11: the old +20.00 interest on 09-30 matches the bonus interest row in growth-2026-09', () => {
    const result = parseAnzPlusStatement(readAnzPlusStatementFixture('growth-2026-09.txt'), '0004');
    if (!result.ok) throw new Error(result.message);
    const old: PendingTx = {
      id: 'P11',
      accountId: anzPlus.id,
      date: '2026-09-30',
      amountCents: 2000,
    };
    const matches = findPendingMatches(result.rows, anzPlus.id, [old]);
    expect(matches.filter((m) => m.kind === 'match')).toEqual([
      { kind: 'match', pendingId: 'P11' },
    ]);
    expect(matches.filter((m) => m.kind !== 'none')).toHaveLength(1);
  });
});
