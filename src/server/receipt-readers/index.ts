// 按 RECEIPT_READER 选 reader（business-rules.md R20.1，tech-stack 11.3）
// llm → llm reader；none、空 → null（打开空的商品表手动填）
// 不认识的值当作 none，打一条警告。text reader 不做（R20.1b，2026-10-29），所以 text 也走这里
import { getLlmClient } from '../llm/client';
import { createLlmReader } from './llm';
import type { ReceiptReader } from './types';

export type { ReadResult, ReceiptInput, ReceiptReader } from './types';

export function getReceiptReader(
  env: Record<string, string | undefined> = process.env,
): ReceiptReader | null {
  const value = env.RECEIPT_READER?.trim() ?? '';
  if (value === 'llm') return createLlmReader(getLlmClient(env));
  if (value === '' || value === 'none') return null;
  console.warn(`RECEIPT_READER="${value}" 不认识，当作 none`);
  return null;
}
