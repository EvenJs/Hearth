// R4.1 去重 key、R4.3 CBA 对账单的补充去重（business-rules.md R4）
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

// R4.3 候选：数据库里同账户已有的交易。balanceCents、dedupeKey 为 null 的（手动录入、pending）不算
export type BalanceCandidate = {
  date: string;
  amountCents: number;
  balanceCents: number | null;
  dedupeKey: string | null;
};

// R4.3 只在导入 CBA 对账单时调用。rows 是 R4.2 按 key 没跳过的行（输出顺序，新的在前），
// keyHits 是这次 R4.2 已经命中的已有交易的 key，那些候选不再用。
// (date, amount_cents, balance_cents) 一样就跳过；一个候选最多抵掉一行，前面的行先用。返回每行是否跳过
export function findBalanceDuplicates(
  rows: readonly Pick<DedupeRow, 'date' | 'amountCents' | 'balanceCents'>[],
  candidates: readonly BalanceCandidate[],
  keyHits: ReadonlySet<string>,
): boolean[] {
  const available = new Map<string, number>();
  for (const c of candidates) {
    if (c.balanceCents === null || c.dedupeKey === null || keyHits.has(c.dedupeKey)) continue;
    const group = `${c.date}|${c.amountCents}|${c.balanceCents}`;
    available.set(group, (available.get(group) ?? 0) + 1);
  }
  return rows.map((row) => {
    if (row.balanceCents === null) return false;
    const group = `${row.date}|${row.amountCents}|${row.balanceCents}`;
    const left = available.get(group) ?? 0;
    if (left === 0) return false;
    available.set(group, left - 1);
    return true;
  });
}
