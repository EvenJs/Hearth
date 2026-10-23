// R9 对账校验、R8.4 导入后提示检查的 pending（business-rules.md R9、R8.4）
// 纯函数，不 import 数据库和 Next.js
import { addDays } from './periods';

export type ReconcileTx = {
  date: string; // YYYY-MM-DD
  amountCents: number;
  status: 'pending' | 'confirmed';
};

export type ReconcileInput = {
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  dateFrom: string;
  dateTo: string;
  transactions: readonly ReconcileTx[]; // 该账户在数据库里的交易，不只是本次文件
};

export type Reconciliation =
  | { status: 'none'; differenceCents: null } // 没有期初期末
  | { status: 'passed'; differenceCents: 0 }
  | { status: 'failed'; differenceCents: number };

// R9：opening + Σ(confirmed，date ∈ [date_from, date_to]) == closing。pending 不算
// differenceCents = closing − (opening + Σ)：正数说明数据库里少了收入（或多了支出）
export function reconcile(input: ReconcileInput): Reconciliation {
  const { openingBalanceCents: opening, closingBalanceCents: closing } = input;
  if (opening === null || closing === null) return { status: 'none', differenceCents: null };

  const sum = input.transactions
    .filter((t) => t.status === 'confirmed' && t.date >= input.dateFrom && t.date <= input.dateTo)
    .reduce((s, t) => s + t.amountCents, 0);
  const differenceCents = closing - (opening + sum);
  return differenceCents === 0
    ? { status: 'passed', differenceCents: 0 }
    : { status: 'failed', differenceCents };
}

// R8.4：日期 ≤ 本次 date_to − 3 天、仍是 pending 的交易，导入结果页提示检查
// 3 天和 R8.2 的匹配窗口一致：再晚的银行流水也不会来确认它了
const CHECK_AFTER_DAYS = 3;

export function pendingsToCheck<T extends { date: string; status: 'pending' | 'confirmed' }>(
  txs: readonly T[],
  dateTo: string,
): T[] {
  const cutoff = addDays(dateTo, -CHECK_AFTER_DAYS);
  return txs.filter((t) => t.status === 'pending' && t.date <= cutoff);
}
