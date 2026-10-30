// pending 交易：R8.1 手动录入时的初始状态，R8.2 导入时找候选
// R8.3 的普通字段在导入事务里直接更新；R8.3 例外（银行那行是内部转账）在这里算
// 纯函数，不 import 数据库和 Next.js
import type { Bank } from '@/lib/accounts/account-input';
import { bySystemKey } from './classify';
import { recomputeMember, type MemberContext } from './member';
import { daysBetween } from './periods';
import type { Account, CategorySource, MemberSource, ProcessedRow } from './types';

export type TransactionStatus = 'pending' | 'confirmed';

// R8.1：能导入的银行（anz、cba 的 CSV，anz_plus 的 PDF 对账单）等导入时确认；cash、other 直接 confirmed
const PENDING_BANKS: readonly Bank[] = ['anz', 'cba', 'anz_plus'];

export function initialStatus(account: Pick<Account, 'bank'>): TransactionStatus {
  return PENDING_BANKS.includes(account.bank) ? 'pending' : 'confirmed';
}

// R8.2 候选：pending，或者 R8.1 改之前在 ANZ Plus 手动记的 confirmed 交易（导入对账单时替换）
// ANZ、CBA 的 confirmed 交易不是候选
export function isMatchCandidate(
  tx: { status: TransactionStatus; source: 'csv' | 'manual' | 'receipt'; importBatchId: string | null },
  account: Pick<Account, 'bank'>,
): boolean {
  if (tx.status === 'pending') return true;
  return account.bank === 'anz_plus' && tx.source === 'manual' && tx.importBatchId === null;
}

// 同账户里的候选（isMatchCandidate 筛过的）
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

// ---------- R8.3 例外 ----------

export type PendingTransferResult =
  // 银行那行不是内部转账：按 R8.3 普通情况，拆分保留用户录入的
  | { kind: 'not_transfer' }
  // R6.1 优先：transaction 和主拆分要改的字段，备注不动
  | {
      kind: 'transfer';
      transferStatus: 'auto';
      transferAccountId: string; // R6.2 配对用，不入库
      primarySplit: {
        categoryId: string;
        categorySource: CategorySource;
        isPreTax: boolean;
        memberId: string;
        memberSource: MemberSource;
      };
    }
  // pending 有多个拆分：什么都不改，保留用户的拆分，F8 提示
  | { kind: 'multiple_splits'; transferAccountId: string };

// R8.3 例外：pending 被确认时，银行那行 R6.1 认出是内部转账
// bankRow 是 processFile 处理过的那行（R6.1 已经跑过）；primaryMember 是 pending 主拆分现在的归属人
// 主拆分改成内部转账（system），is_pre_tax 跟着分类走（R7），归属人按 R5.1（manual 不动）
export function confirmPendingTransfer(
  bankRow: Pick<ProcessedRow, 'accountId' | 'cardLast4' | 'transferStatus' | 'transferAccountId'>,
  pending: { splitCount: number; primaryMember: { memberId: string; memberSource: MemberSource } },
  ctx: MemberContext,
): PendingTransferResult {
  if (bankRow.transferStatus !== 'auto' || !bankRow.transferAccountId) {
    return { kind: 'not_transfer' };
  }
  if (pending.splitCount > 1) {
    return { kind: 'multiple_splits', transferAccountId: bankRow.transferAccountId };
  }

  const internal = bySystemKey(ctx.categories, 'internal_transfer');
  const member = recomputeMember(
    { ...pending.primaryMember, accountId: bankRow.accountId, cardLast4: bankRow.cardLast4 },
    internal.id,
    ctx,
  );
  return {
    kind: 'transfer',
    transferStatus: 'auto',
    transferAccountId: bankRow.transferAccountId,
    primarySplit: {
      categoryId: internal.id,
      categorySource: 'system',
      isPreTax: internal.isPreTaxDefault,
      ...member,
    },
  };
}
