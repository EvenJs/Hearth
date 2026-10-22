import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('runs a basic assertion', () => {
    expect(1 + 1).toBe(2);
  });

  it('resolves the @/ alias to src/', async () => {
    // @/.. 指向项目根目录，能读到 package.json 说明别名生效
    const pkg = await import('@/../package.json');
    expect(pkg.name).toBe('hearth');
  });
});
