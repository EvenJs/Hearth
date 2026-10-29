import { describe, expect, it } from 'vitest';
import { csvGapWarning, importCoverage } from './coverage';

// 期望值来自 business-rules.md R12.2 和 fixtures/README.md S9、S10

describe('importCoverage', () => {
  it('R12.2: account never imported → nothing to show', () => {
    expect(importCoverage([], '2026-10-29')).toEqual({
      lastDateTo: null,
      suggestedFrom: null,
      suggestedTo: null,
      statementDateTo: null,
    });
  });

  it('R12.2 / S9: after joint-2026-09.csv → last 2026-09-30, suggest 2026-09-23 to today', () => {
    expect(importCoverage([{ source: 'csv', dateTo: '2026-09-30' }], '2026-10-29')).toEqual({
      lastDateTo: '2026-09-30',
      suggestedFrom: '2026-09-23',
      suggestedTo: '2026-10-29',
      statementDateTo: null,
    });
  });

  it('R12.2: last = largest date_to over CSV and PDF; statements only count PDF', () => {
    const batches = [
      { source: 'pdf', dateTo: '2026-09-30' },
      { source: 'csv', dateTo: '2026-10-08' },
      { source: 'pdf', dateTo: '2026-08-31' },
      { source: 'csv', dateTo: '2026-09-15' },
    ] as const;
    expect(importCoverage(batches, '2026-10-29')).toEqual({
      lastDateTo: '2026-10-08',
      suggestedFrom: '2026-10-01',
      suggestedTo: '2026-10-29',
      statementDateTo: '2026-09-30',
    });
  });

  it('R12.2: a statement can be the latest import', () => {
    const batches = [
      { source: 'csv', dateTo: '2026-10-20' },
      { source: 'pdf', dateTo: '2026-10-31' },
    ] as const;
    expect(importCoverage(batches, '2026-11-03')).toMatchObject({
      lastDateTo: '2026-10-31',
      suggestedFrom: '2026-10-24',
      statementDateTo: '2026-10-31',
    });
  });

  it('R12.2: minus 7 days crosses month and year', () => {
    expect(
      importCoverage([{ source: 'csv', dateTo: '2027-01-03' }], '2027-01-10').suggestedFrom,
    ).toBe('2026-12-27');
    expect(
      importCoverage([{ source: 'csv', dateTo: '2026-03-02' }], '2026-03-10').suggestedFrom,
    ).toBe('2026-02-23');
  });
});

describe('csvGapWarning', () => {
  it('R12.2: never imported → no warning', () => {
    expect(csvGapWarning('2026-10-05', null)).toBeNull();
  });

  it('R12.2 / S10: earliest 2026-10-05 after last 2026-09-30 → warning', () => {
    expect(csvGapWarning('2026-10-05', '2026-09-30')).toEqual({
      dateFrom: '2026-10-05',
      previousDateTo: '2026-09-30',
    });
  });

  it('R12.2: the very next day still has no overlap → warning', () => {
    expect(csvGapWarning('2026-10-01', '2026-09-30')).toEqual({
      dateFrom: '2026-10-01',
      previousDateTo: '2026-09-30',
    });
  });

  it('R12.2: same day or earlier overlaps → no warning', () => {
    expect(csvGapWarning('2026-09-30', '2026-09-30')).toBeNull();
    expect(csvGapWarning('2026-09-25', '2026-09-30')).toBeNull();
  });
});
