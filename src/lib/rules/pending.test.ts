import { describe, expect, it } from 'vitest';
import { processFile } from '@/lib/import/process';
import { readFixture } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { findPendingMatches, initialStatus, type PendingTx } from './pending';

// 期望值来自 business-rules.md R8.1、R8.2 和 fixtures/README.md "pending 匹配用例"
// 只测找候选，确认动作（R8.3）在 M3 的事务里做

const h = buildTestHousehold();
const joint = h.account('ANZ Joint');

describe('initialStatus（R8.1）', () => {
  it('R8.1 P7: ANZ Plus has no parser → confirmed', () => {
    expect(initialStatus(h.account('ANZ Plus Male'))).toBe('confirmed');
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
