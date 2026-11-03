import { describe, expect, it } from 'vitest';
import { canImportCsv, canImportStatement } from './banks';

describe('canImportCsv', () => {
  it('R1: anz and cba have a CSV parser', () => {
    expect(canImportCsv('anz')).toBe(true);
    expect(canImportCsv('cba')).toBe(true);
  });

  it('R1: anz_plus, cash and other cannot import CSV', () => {
    expect(canImportCsv('anz_plus')).toBe(false);
    expect(canImportCsv('cash')).toBe(false);
    expect(canImportCsv('other')).toBe(false);
  });
});

describe('canImportStatement', () => {
  it('R1C / R1D / R1E: anz, anz_plus and cba can import a PDF statement', () => {
    expect(canImportStatement('anz')).toBe(true);
    expect(canImportStatement('anz_plus')).toBe(true);
    expect(canImportStatement('cba')).toBe(true);
  });

  it('R1: cash and other cannot import a PDF statement', () => {
    expect(canImportStatement('cash')).toBe(false);
    expect(canImportStatement('other')).toBe(false);
  });
});
