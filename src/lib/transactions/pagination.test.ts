import { describe, expect, it } from 'vitest';
import { parsePageInput } from './pagination';

// 期望值来自 docs/design/README.md 第 3 节（分页）和 docs/tasks/m5.5.md M5.5-5

describe('parsePageInput（跳页）', () => {
  it.each([
    ['3', 3],
    ['1', 1],
    [' 2 ', 2], // 前后空格不算
    ['9', 3], // 超出范围按 N
    ['0', 1], // 小于 1 按 1
    ['003', 3],
  ] as const)('page jump: "%s" with 3 pages → %d', (text, page) => {
    expect(parsePageInput(text, 3)).toBe(page);
  });

  it.each(['', '  ', 'abc', '2.5', '-1', '1e2', '３'])(
    'page jump: "%s" is not a number → null (no jump)',
    (text) => {
      expect(parsePageInput(text, 3)).toBeNull();
    },
  );
});
