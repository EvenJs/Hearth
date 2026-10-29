// 小票 reader 的接口（business-rules.md R20.1，tech-stack 11.3）
// 所有 reader 返回同一个原始结果，schema 在 src/lib/rules/receipt.ts
import type { RawReceipt } from '@/lib/rules/receipt';

export type ReceiptInput = { kind: 'image'; image: Blob } | { kind: 'text'; text: string };

// reader 存进 receipt.reader：`llm:<模型名>`、`text`（schema）
export type ReadResult =
  { ok: true; raw: RawReceipt; reader: string } | { ok: false; reason: string };

export interface ReceiptReader {
  id: 'llm' | 'text';
  input: 'image' | 'text'; // 核对界面据此显示"拍照"还是"粘贴文字"
  // categories：本家庭能选的支出二级分类，格式 `一级 / 二级`（R20.1a）
  // 不抛错，失败返回 { ok: false, reason }
  read(input: ReceiptInput, categories: string[]): Promise<ReadResult>;
}
