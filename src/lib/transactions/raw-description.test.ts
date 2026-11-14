import { describe, expect, it } from 'vitest';
import { rawDescriptionTitle } from './raw-description';

// M13-6 第 11 条：商家列只显示商家名，原始描述放悬停
// 原始描述和商家名去掉大小写、空格后一样时，连悬停也不加

describe('rawDescriptionTitle', () => {
  it('different from merchant → raw description as title', () => {
    expect(rawDescriptionTitle('COLES 1234 MELBOURNE AU', 'Coles')).toBe(
      'COLES 1234 MELBOURNE AU',
    );
  });

  it('same ignoring case → no title', () => {
    expect(rawDescriptionTitle('COLES', 'Coles')).toBeUndefined();
  });

  it('same ignoring spaces → no title', () => {
    expect(rawDescriptionTitle('WOOL WORTHS ', 'Woolworths')).toBeUndefined();
    expect(rawDescriptionTitle('Netflix', 'NET FLIX')).toBeUndefined();
  });

  it('other punctuation still counts as different', () => {
    expect(rawDescriptionTitle('UBER* EATS', 'Uber Eats')).toBe('UBER* EATS');
  });
});
