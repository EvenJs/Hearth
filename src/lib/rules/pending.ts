// pending 交易：R8.1 手动录入时的初始状态，R8.2 导入时找候选
// 确认时更新字段（R8.3）在 M3 的导入事务里做
// 纯函数，不 import 数据库和 Next.js
import { canImportCsv } from '@/lib/import/banks';
import { daysBetween } from './periods';
import type { Account } from './types';

export type TransactionStatus = 'pending' | 'confirmed';

// R8.1：有 CSV 解析器的银行（anz、cba）等导入时确认；没有的（cash、anz_plus、other）直接 confirmed
export function initialStatus(account: Pick<Account, 'bank'>): TransactionStatus {
  return canImportCsv(account.bank) ? 'pending' : 'confirmed';
}

// 同账户里还是 pending 的交易
export type PendingTx = {
  id: string;
  accountId: string;
  date: string; // YYYY-MM-DD
  amountCents: number;
};

export type PendingMatch =
  | { kind: 'none' } // 0 个候选：正常插入
  | { kind: 'match'; pendingId: string } // 1 个：确认这笔 pending，不插入新交易
  | { kind: 'ambiguous'; pendingIds: string[] }; // ≥ 2 个：正常插入，两边提示"可能重复"

// R8.2 银行入账不会早于消费，最多晚 3 天
const MAX_DAYS_LATER = 3;

// R8.2：rows 是通过去重检查（R4）的 CSV 行，按文件顺序处理，结果和 rows 一一对应
// 一笔 pending 被前面的行匹配走后，后面的行不再看到它；ambiguous 不占用候选
export function findPendingMatches(
  rows: readonly { date: string; amountCents: number }[],
  accountId: string,
  pendings: readonly PendingTx[],
): PendingMatch[] {
  const available = pendings.filter((p) => p.accountId === accountId);
  const taken = new Set<string>();

  return rows.map((row): PendingMatch => {
    const candidates = available.filter((p) => {
      if (taken.has(p.id) || p.amountCents !== row.amountCents) return false;
      const later = daysBetween(p.date, row.date); // CSV 日期 − pending 日期
      return later >= 0 && later <= MAX_DAYS_LATER;
    });

    if (candidates.length === 0) return { kind: 'none' };
    if (candidates.length === 1) {
      taken.add(candidates[0].id);
      return { kind: 'match', pendingId: candidates[0].id };
    }
    return { kind: 'ambiguous', pendingIds: candidates.map((p) => p.id) };
  });
}
