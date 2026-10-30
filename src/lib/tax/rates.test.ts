import { describe, expect, it } from 'vitest';
import { availableFinancialYears, financialYearLabel, getTaxRates } from './rates';

// 期望值来自 business-rules.md R14.1、R14.7

describe('financialYearLabel（R14.1）', () => {
  it.each([
    [2026, '2026-27'],
    [2025, '2025-26'],
    [2099, '2099-00'],
    [2009, '2009-10'],
  ])('R14.1: %i is shown as %s', (fy, label) => {
    expect(financialYearLabel(fy)).toBe(label);
  });
});

describe('availableFinancialYears（R14.7）', () => {
  it('R14.7: lists financial years newest first', () => {
    const years = availableFinancialYears();
    expect(years.length).toBeGreaterThan(0);
    expect([...years].sort((a, b) => b - a)).toEqual(years);
  });

  it('R14.7: every listed year has a rate table', () => {
    for (const fy of availableFinancialYears()) {
      expect(() => getTaxRates(fy)).not.toThrow();
    }
  });

  it('R14.7: a year without a rate table is not listed', () => {
    // 2027-28 还没加（R14.4）
    expect(() => getTaxRates(2027)).toThrow();
    expect(availableFinancialYears()).not.toContain(2027);
  });
});
