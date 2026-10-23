import { describe, expect, it } from 'vitest';
import { canImportCsv } from './banks';

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
