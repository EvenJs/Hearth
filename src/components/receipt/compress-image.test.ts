import { describe, expect, it } from 'vitest';
import { fitWithin, MAX_LONG_SIDE } from './compress-image';

// tech-stack 11.3：长边 ≤ 1600px，等比，小图不放大

describe('fitWithin（tech-stack 11.3）', () => {
  it('portrait phone photo 3024×4032 → 1200×1600', () => {
    expect(fitWithin(3024, 4032, MAX_LONG_SIDE)).toEqual({ width: 1200, height: 1600 });
  });

  it('landscape 4032×3024 → 1600×1200', () => {
    expect(fitWithin(4032, 3024, MAX_LONG_SIDE)).toEqual({ width: 1600, height: 1200 });
  });

  it('already small → unchanged, not enlarged', () => {
    expect(fitWithin(800, 1200, MAX_LONG_SIDE)).toEqual({ width: 800, height: 1200 });
    expect(fitWithin(1600, 900, MAX_LONG_SIDE)).toEqual({ width: 1600, height: 900 });
  });

  it('very long receipt 1000×9000 keeps its ratio and at least 1px wide', () => {
    expect(fitWithin(1000, 9000, MAX_LONG_SIDE)).toEqual({ width: 178, height: 1600 });
    expect(fitWithin(1, 100000, MAX_LONG_SIDE)).toEqual({ width: 1, height: 1600 });
  });
});
