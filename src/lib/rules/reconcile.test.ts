import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../tests/helpers/fixtures';
import { deriveBalances, parseCbaCsv } from '../import/cba';
import { pendingsToCheck, reconcile } from './reconcile';

// 期望值来自 business-rules.md R9、R8.4 和 fixtures/README.md（cba female、broken-balance、P5/P6）

function cbaInput(path: 'cba/female-2026-09.csv' | 'cba/broken-balance.csv') {
  const rows = parseCbaCsv(readFixture(path));
  const dates = rows.map((r) => r.date).sort();
  return {
    ...deriveBalances(rows),
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    transactions: rows.map((r) => ({
      date: r.date,
      amountCents: r.amountCents,
      status: 'confirmed' as const,
    })),
  };
}

describe('reconcile（R9）', () => {
  it('R9: female-2026-09.csv reconciles: opening 10,000.00, closing 11,561.59', () => {
    const input = cbaInput('cba/female-2026-09.csv');
    expect(input.openingBalanceCents).toBe(1000000);
    expect(input.closingBalanceCents).toBe(1156159);
    expect(reconcile(input)).toEqual({ status: 'passed', differenceCents: 0 });
  });

  it('R9: broken-balance.csv still reconciles (R1B.1 and R9 check different things)', () => {
    const input = cbaInput('cba/broken-balance.csv');
    expect(input.openingBalanceCents).toBe(944925);
    expect(reconcile(input)).toEqual({ status: 'passed', differenceCents: 0 });
  });

  it('R9: no opening/closing (ANZ left empty) → none', () => {
    const input = cbaInput('cba/female-2026-09.csv');
    expect(reconcile({ ...input, openingBalanceCents: null, closingBalanceCents: null })).toEqual({
      status: 'none',
      differenceCents: null,
    });
  });

  it('R9: a missing transaction → failed, difference = closing − (opening + Σ)', () => {
    const input = cbaInput('cba/female-2026-09.csv');
    // 少了 #1 CREDIT INTEREST +12.34
    const missing = { ...input, transactions: input.transactions.slice(1) };
    expect(reconcile(missing)).toEqual({ status: 'failed', differenceCents: 1234 });
  });

  it('R9: pending transactions do not count', () => {
    const input = cbaInput('cba/female-2026-09.csv');
    const withPending = {
      ...input,
      transactions: [
        ...input.transactions,
        { date: '2026-09-15', amountCents: -1500, status: 'pending' as const },
      ],
    };
    expect(reconcile(withPending)).toEqual({ status: 'passed', differenceCents: 0 });
  });

  it('R9: only transactions with date in [date_from, date_to] count, both ends included', () => {
    const base = {
      openingBalanceCents: 0,
      closingBalanceCents: 300,
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
    };
    const tx = (date: string, amountCents: number) => ({
      date,
      amountCents,
      status: 'confirmed' as const,
    });
    expect(
      reconcile({
        ...base,
        transactions: [
          tx('2026-08-31', 999),
          tx('2026-09-01', 100),
          tx('2026-09-30', 200),
          tx('2026-10-01', 999),
        ],
      }),
    ).toEqual({ status: 'passed', differenceCents: 0 });
  });
});

describe('pendingsToCheck（R8.4）', () => {
  const tx = (id: string, date: string, status: 'pending' | 'confirmed' = 'pending') => ({
    id,
    date,
    status,
  });

  it('R8.4: pending with date ≤ date_to − 3 days are listed; later ones and confirmed are not', () => {
    const txs = [
      tx('P6', '2026-09-02'),
      tx('P5', '2026-09-05'),
      tx('edge', '2026-09-27'),
      tx('recent', '2026-09-28'),
      tx('confirmed', '2026-09-01', 'confirmed'),
    ];
    expect(pendingsToCheck(txs, '2026-09-30').map((t) => t.id)).toEqual(['P6', 'P5', 'edge']);
  });

  it('R8.4: works across month ends', () => {
    expect(pendingsToCheck([tx('a', '2026-09-29'), tx('b', '2026-09-30')], '2026-10-02')).toEqual([
      tx('a', '2026-09-29'),
    ]);
  });
});
