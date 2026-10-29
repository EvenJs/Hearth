import { afterEach, describe, expect, it, vi } from 'vitest';
import { getReceiptReader } from './index';

// R20.1、tech-stack 11.3：RECEIPT_READER 选 reader

afterEach(() => vi.restoreAllMocks());

describe('getReceiptReader（R20.1）', () => {
  it('R20.1: llm gives the llm reader with image input', () => {
    const reader = getReceiptReader({ RECEIPT_READER: 'llm' });
    expect(reader?.id).toBe('llm');
    expect(reader?.input).toBe('image');
  });

  it.each([['none'], [''], ['  ']])('R20.1: "%s" gives null without a warning', (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getReceiptReader({ RECEIPT_READER: value })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('R20.1: unset gives null', () => {
    expect(getReceiptReader({})).toBeNull();
  });

  it.each([['LLM'], ['gpt'], ['text']])(
    'R20.1: unknown "%s" is treated as none with a warning',
    (value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(getReceiptReader({ RECEIPT_READER: value })).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it('R20.1: llm without LLM_* configured still gives a reader, which fails when read', async () => {
    const reader = getReceiptReader({ RECEIPT_READER: 'llm' });
    const result = await reader!.read(
      { kind: 'image', image: new Blob([new Uint8Array([1])]) },
      [],
    );
    expect(result.ok).toBe(false);
  });
});
