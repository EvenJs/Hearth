import { describe, expect, it } from 'vitest';
import {
  csvGapWarning,
  importCoverage,
  overlappingStatements,
  previousStatement,
  type StatementBatch,
} from './coverage';

// 期望值来自 business-rules.md R12.2 和 fixtures/README.md S9、S10、fixtures/cases/18-boq-westpac-statement.md
// WD3 到 WD5、QD4、QD5

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

// R12.2 PDF 对账单：首尾衔接只找 date_to 早于本次 date_from 的；账期有交集的另外提示重叠（2026-11-15）
const stmt = (batchId: string, dateFrom: string, dateTo: string): StatementBatch => ({
  batchId,
  dateFrom,
  dateTo,
});
const NOVEMBER = stmt('nov', '2026-11-01', '2026-11-30');
const ONE_DAY = stmt('one-day', '2026-11-03', '2026-11-03');
const ON_DEMAND = stmt('on-demand', '2026-11-03', '2026-11-06');

describe('previousStatement（R12.2 首尾衔接）', () => {
  it('R12.2: no statement batch → null', () => {
    expect(previousStatement([], '2026-11-01')).toBeNull();
  });

  it('R12.2 WD4 / QD5: November then December → previous is November', () => {
    expect(previousStatement([NOVEMBER], '2026-12-01')).toEqual(NOVEMBER);
  });

  it('R12.2 WD3 / QD4: an on-demand statement inside the period is not the previous one', () => {
    expect(previousStatement([ONE_DAY], '2026-11-01')).toBeNull();
    expect(previousStatement([ON_DEMAND], '2026-11-01')).toBeNull();
  });

  it('R12.2 WD5: importing the one-day statement after November → no previous (November ends later)', () => {
    expect(previousStatement([NOVEMBER], '2026-11-03')).toBeNull();
  });

  it('R12.2 R1C: ANZ date_from is the day after the previous date_to → still connected', () => {
    const sept = stmt('sept', '2026-09-01', '2026-09-30');
    expect(previousStatement([sept], '2026-10-01')).toEqual(sept);
  });

  it('R12.2: several earlier statements → the one with the largest date_to; ties keep the first', () => {
    const sept = stmt('sept', '2026-09-01', '2026-09-30');
    const octA = stmt('oct-a', '2026-10-01', '2026-10-31');
    const octB = stmt('oct-b', '2026-10-15', '2026-10-31');
    expect(previousStatement([sept, octA, octB], '2026-11-01')).toEqual(octA);
  });
});

describe('overlappingStatements（R12.2 账期重叠）', () => {
  it('R12.2 WD3 / QD4: November overlaps the on-demand statement imported before', () => {
    expect(overlappingStatements([ONE_DAY], '2026-11-01', '2026-11-30')).toEqual([ONE_DAY]);
    expect(overlappingStatements([ON_DEMAND], '2026-11-01', '2026-11-30')).toEqual([ON_DEMAND]);
  });

  it('R12.2 WD5: the one-day statement overlaps November', () => {
    expect(overlappingStatements([NOVEMBER], '2026-11-03', '2026-11-03')).toEqual([NOVEMBER]);
  });

  it('R12.2 WD4: back-to-back periods do not overlap', () => {
    expect(overlappingStatements([NOVEMBER], '2026-12-01', '2026-12-31')).toEqual([]);
  });

  it('R12.2: sharing one boundary day counts as overlap (closed periods)', () => {
    expect(overlappingStatements([NOVEMBER], '2026-11-30', '2026-12-31')).toEqual([NOVEMBER]);
  });

  it('R12.2: several overlaps are listed by date_from', () => {
    expect(
      overlappingStatements([ON_DEMAND, NOVEMBER, ONE_DAY], '2026-11-02', '2026-11-04'),
    ).toEqual([NOVEMBER, ONE_DAY, ON_DEMAND]);
  });
});
