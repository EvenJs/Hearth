import { describe, expect, it } from 'vitest';
import { cardInputSchema } from './card-input';

const MEMBER_ID = '6f1c2a3e-9b4d-4c5e-8f7a-1b2c3d4e5f60';
const valid = { last4: '1111', memberId: MEMBER_ID, label: '' };

function errorsOf(input: unknown) {
  const r = cardInputSchema.safeParse(input);
  if (r.success) return null;
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

describe('cardInputSchema', () => {
  it('accepts the two ANZ Joint cards in fixtures/README.md', () => {
    expect(cardInputSchema.parse({ ...valid, last4: '1111' })).toEqual({
      last4: '1111',
      memberId: MEMBER_ID,
      label: null,
    });
    expect(cardInputSchema.parse({ ...valid, last4: '2222' }).last4).toBe('2222');
  });

  it('trims last4', () => {
    expect(cardInputSchema.parse({ ...valid, last4: ' 1111 ' }).last4).toBe('1111');
  });

  it.each(['', '111', '11111', '12a4', '12 4', '１１１１', '-111'])(
    'last4 %j is rejected',
    (last4) => {
      expect(errorsOf({ ...valid, last4 })).toEqual([
        { path: 'last4', message: '后四位是 4 位数字' },
      ]);
    },
  );

  it('label is optional: trimmed, empty becomes null', () => {
    expect(cardInputSchema.parse({ ...valid, label: '  我的借记卡 ' }).label).toBe('我的借记卡');
    expect(cardInputSchema.parse({ ...valid, label: '   ' }).label).toBeNull();
    expect(errorsOf({ ...valid, label: 'x'.repeat(51) })?.[0].path).toBe('label');
  });

  it('memberId must be a uuid', () => {
    expect(errorsOf({ ...valid, memberId: 'Male' })).toEqual([
      { path: 'memberId', message: '请选择归属人' },
    ]);
  });
});
