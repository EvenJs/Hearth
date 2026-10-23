import { describe, expect, it } from 'vitest';
import { suggestKeyword } from './keyword';

// 期望值来自 business-rules.md R13 和 docs/tasks/m2.md M2-13

describe('suggestKeyword（R13）', () => {
  it.each([
    ['COLES 0559 MELBOURNE', 'COLES'],
    ['KIS HAIR MELBOURNE', 'KIS HAIR MELBOURNE'],
    ['WOOLWORTHS 3141 SOUTH YARRA', 'WOOLWORTHS'],
    ['CROWN ASIAN SPENCER DOCKLANDS', 'CROWN ASIAN SPENCER DOCKLANDS'],
    ['7-ELEVEN 2045 MELBOURNE', '7-ELEVEN'], // 7-ELEVEN 不是纯数字词
    ['EASI AU ****2605', 'EASI AU ****2605'], // 脱敏的不是纯数字词
    ['BPAY SEENE', 'BPAY SEENE'],
  ])('R13: %s → %s', (merchant, keyword) => {
    expect(suggestKeyword(merchant)).toBe(keyword);
  });

  it('R13: extra spaces are collapsed', () => {
    expect(suggestKeyword('  COLES   0559 MELBOURNE ')).toBe('COLES');
  });

  it('R13: first word is a number → whole merchant (keyword cannot be empty)', () => {
    expect(suggestKeyword('1300 SMILES MELBOURNE')).toBe('1300 SMILES MELBOURNE');
  });
});
