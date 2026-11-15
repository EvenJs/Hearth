import { describe, expect, it } from 'vitest';
import { financialYearDays, jobDaysInYear, proratedSalaryCents, prorateJobs } from './jobs';

// 期望值来自 business-rules.md R14.9 和 fixtures/cases/19-tax-jobs.md

const job = (annualSalaryCents: number, startDate: string, endDate: string | null) => ({
  annualSalaryCents,
  startDate,
  endDate,
});

describe('天数工具（R14.9，19 号场景 0）', () => {
  it.each([
    [2026, 365],
    [2025, 365],
    [2027, 366],
    [2023, 366],
  ])('R14.9: financial year %i has %i days', (fy, days) => {
    expect(financialYearDays(fy)).toBe(days);
  });

  it.each([
    ['2027-01-01', null, 181],
    ['2026-07-01', '2026-07-01', 1],
    ['2024-01-01', '2026-06-30', 0],
    ['2027-07-01', null, 0],
  ])('R14.9: [%s, %s] ∩ FY 2026 = %i days', (start, end, days) => {
    expect(jobDaysInYear(job(100, start, end), 2026)).toBe(days);
  });
});

describe('prorateJobs（R14.9）', () => {
  it('R14.9 A: start 2027-01-01, still employed → 181 days, 59,506.85 / 14,341.15', () => {
    const r = prorateJobs([job(12000000, '2027-01-01', null)], 2026);
    expect(r.jobs[0]).toMatchObject({ days: 181, grossCents: 5950685, withheldCents: 1434115 });
    expect(r.grossCents).toBe(5950685);
    expect(r.withheldCents).toBe(1434115);
  });

  it.each([
    [2026, 92, 2268493, 486970],
    [2025, 365, 9000000, 1958800],
  ])('R14.9 B: left 2026-09-30, FY %i → %i days', (fy, days, gross, withheld) => {
    const r = prorateJobs([job(9000000, '2025-03-01', '2026-09-30')], fy);
    expect(r.jobs[0]).toMatchObject({ days, grossCents: gross, withheldCents: withheld });
  });

  it.each([
    [2025, 91, 2493151, 568139],
    [2026, 184, 5041096, 1135255],
  ])(
    'R14.9 C: one job across two years uses each year’s own tax table, FY %i',
    (fy, days, gross, withheld) => {
      const r = prorateJobs([job(10000000, '2026-04-01', '2026-12-31')], fy);
      expect(r.jobs[0]).toMatchObject({ days, grossCents: gross, withheldCents: withheld });
    },
  );

  it('R14.9 C-2 / R14.7: FY 2027 salary still prorates, withheld throws for missing tax table', () => {
    const gamma = job(10000000, '2026-04-01', null);
    expect(jobDaysInYear(gamma, 2027)).toBe(366);
    expect(proratedSalaryCents(gamma, 2027)).toBe(10000000);
    expect(() => prorateJobs([gamma], 2027)).toThrow('2027-28');
  });

  it('R14.9 D: two overlapping jobs both count, each rounded then summed', () => {
    const r = prorateJobs(
      [job(8000000, '2025-01-01', null), job(3000000, '2026-10-01', '2027-03-31')],
      2026,
    );
    expect(r.jobs.map((j) => [j.days, j.grossCents, j.withheldCents])).toEqual([
      [365, 8000000, 1612000],
      [182, 1495890, 118175],
    ]);
    expect(r.grossCents).toBe(9495890);
    expect(r.withheldCents).toBe(1730175);
  });

  it('R14.9: job outside the year → 0 days, 0 prorated', () => {
    const r = prorateJobs([job(9000000, '2025-03-01', '2026-06-30')], 2026);
    expect(r.jobs[0]).toMatchObject({ days: 0, grossCents: 0, withheldCents: 0 });
    expect(r.grossCents).toBe(0);
    expect(r.withheldCents).toBe(0);
  });

  it('R14.9: no jobs → 0', () => {
    expect(prorateJobs([], 2026)).toEqual({ jobs: [], grossCents: 0, withheldCents: 0 });
  });

  it('R14.9: per-job result keeps the original job object', () => {
    const j = { ...job(12000000, '2027-01-01', null), id: 'acme' };
    expect(prorateJobs([j], 2026).jobs[0].job).toBe(j);
  });
});
