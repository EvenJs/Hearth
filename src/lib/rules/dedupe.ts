// R4.1 去重 key（business-rules.md R4.1）
// 纯函数，不 import 数据库和 Next.js。node:crypto 只在服务端用（导入走 Server Action）
import { createHash } from 'node:crypto';

// 生成 key 需要的字段。description 必须是 R2.3 脱敏后的原始描述（不是 merchant）
export type DedupeRow = {
  date: string; // YYYY-MM-DD
  amountCents: number;
  description: string;
  balanceCents: number | null; // CBA 有，ANZ 为 null
};

// R4.1 normalizedDescription：转大写，连续空白合并成一个空格，去首尾空白
export function normalizeDescription(description: string): string {
  return description.toUpperCase().replace(/\s+/g, ' ').trim();
}

// R4.1 occurrence：同一个文件里 (date, amount_cents, normalizedDescription) 相同的第几笔，从 1 开始
// 按文件顺序计数，不要求相邻；余额不参与分组（CBA 同店同额两笔余额不同，也是 1、2）
export function assignOccurrences<T extends Omit<DedupeRow, 'balanceCents'>>(
  rows: readonly T[],
): (T & { occurrence: number })[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    // description 放最后，前两个字段格式固定，用 | 拼接不会撞
    const group = `${row.date}|${row.amountCents}|${normalizeDescription(row.description)}`;
    const occurrence = (seen.get(group) ?? 0) + 1;
    seen.set(group, occurrence);
    return { ...row, occurrence };
  });
}

// R4.1 dedupe_key = sha256(account_id | date | amount_cents | normalizedDescription | occurrence | balance_cents)
// balance_cents 为 null 时写空字符串。输出小写 hex
export function dedupeKey(accountId: string, row: DedupeRow, occurrence: number): string {
  const parts = [
    accountId,
    row.date,
    String(row.amountCents),
    normalizeDescription(row.description),
    String(occurrence),
    row.balanceCents === null ? '' : String(row.balanceCents),
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}
