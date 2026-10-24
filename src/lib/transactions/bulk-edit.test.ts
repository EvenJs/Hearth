import { describe, expect, it } from 'vitest';
import { bulkResultMessage, selectionState } from './bulk-edit';

// 期望值来自 business-rules.md R16.1、R16.2

describe('selectionState', () => {
  const page = ['a', 'b', 'c'];

  it('nothing selected on this page is none', () => {
    expect(selectionState(new Set(), page)).toBe('none');
  });

  it('some rows selected is some', () => {
    expect(selectionState(new Set(['a']), page)).toBe('some');
  });

  it('every row on the page selected is all', () => {
    expect(selectionState(new Set(['a', 'b', 'c']), page)).toBe('all');
  });

  it('ids not on this page do not count', () => {
    expect(selectionState(new Set(['x', 'y', 'z']), page)).toBe('none');
  });

  it('empty page is none', () => {
    expect(selectionState(new Set(['a']), [])).toBe('none');
  });
});

describe('bulkResultMessage', () => {
  it('R16.1: no skips only says how many were changed', () => {
    expect(bulkResultMessage('category', { updatedCount: 3, skippedCount: 0 })).toBe('改了 3 笔');
  });

  it('R16.1 + R16.2: changing category explains split and transfer skips', () => {
    expect(bulkResultMessage('category', { updatedCount: 2, skippedCount: 1 })).toBe(
      '改了 2 笔，跳过 1 笔（拆过的交易、内部转账不能批量改分类）',
    );
  });

  it('R16.1: changing member only skips split transactions', () => {
    expect(bulkResultMessage('member', { updatedCount: 2, skippedCount: 1 })).toBe(
      '改了 2 笔，跳过 1 笔（拆过的交易要在子行里单独改）',
    );
  });

  it('everything skipped still reports both numbers', () => {
    expect(bulkResultMessage('category', { updatedCount: 0, skippedCount: 2 })).toBe(
      '改了 0 笔，跳过 2 笔（拆过的交易、内部转账不能批量改分类）',
    );
  });
});
