// R12.1 撤销导入：算出配对的另一半怎么改、弹窗显示几笔（business-rules.md R12.1）
// 只做判断，删除交易、恢复 pending 在 M3-5 的事务里做。纯函数，不 import 数据库和 Next.js
import { bySystemKey } from './classify';
import { extractMaskedTransferSuffix } from './extract';
import { recomputeMember } from './member';
import { detectTransfer } from './transfer';
import type {
  Account,
  Card,
  Category,
  CategorySource,
  MemberSource,
  TransferStatus,
} from './types';

// 被撤销批次里的一笔：本批次插入的（要删除），或本批次确认的 pending（要恢复）
export type UndoBatchTx = {
  id: string;
  transferPairId: string | null;
  wasPending: boolean; // true = 被本批次确认的 pending
  splits: readonly {
    categorySource: CategorySource;
    memberSource: MemberSource;
    note: string | null;
  }[];
};

// 和批次里的交易配了对的另一半（不在批次里）
export type UndoCounterpart = {
  id: string;
  accountId: string;
  rawDescription: string; // 数据库里脱敏后的描述
  cardLast4: string | null;
  transferStatus: TransferStatus;
  transferPairId: string | null;
  primarySplit: {
    categoryId: string;
    categorySource: CategorySource;
    memberId: string;
    memberSource: MemberSource;
  };
};

// R12.1 表格的四种情况（suggested 和 confirmed 分开记，处理一样）
export type CounterpartCase =
  | 'none' // R6.2 配对时它是 manual 分类，没改
  | 'suggested'
  | 'confirmed'
  | 'auto_still_detected' // 用它自己的描述重跑 R6.1 还能认出
  | 'auto_not_detected'; // 重跑 R6.1 认不出（当初是 R6.2 改的，如 CBA 的 PayID 转账）

export type CounterpartPlan =
  // 只清空 transfer_pair_id
  | { id: string; case: 'none' | 'auto_still_detected'; action: 'unpair' }
  // 清空配对，transfer_status = none，主拆分改回未分类，归属人按 R5.1 重算
  | {
      id: string;
      case: 'suggested' | 'confirmed' | 'auto_not_detected';
      action: 'reset';
      transferStatus: 'none';
      primarySplit: {
        categoryId: string;
        categorySource: 'system';
        isPreTax: boolean;
        memberId: string;
        memberSource: MemberSource;
      };
    };

export type UndoPlan = {
  counterparts: CounterpartPlan[]; // 按批次交易的顺序
  prompt: {
    manualEditedCount: number; // 要删除的交易里手动改过的
    confirmedPendingCount: number; // 要恢复成 pending 的
    needsConfirm: boolean; // 两个都是 0 时直接撤销
  };
};

export type UndoInput = {
  batchTxs: readonly UndoBatchTx[];
  counterparts: readonly UndoCounterpart[];
  accounts: readonly Account[];
  categories: readonly Category[];
  cards: readonly Card[];
};

// R12.1 弹窗：category_source 或 member_source 是 manual、有多个拆分、有备注
function manuallyEdited(tx: UndoBatchTx): boolean {
  return (
    tx.splits.length > 1 ||
    tx.splits.some(
      (s) => s.categorySource === 'manual' || s.memberSource === 'manual' || Boolean(s.note),
    )
  );
}

// R12.1：用数据库里脱敏后的描述重跑 R6.1，****1234 当成 4 位尾号
function stillDetected(c: UndoCounterpart, accounts: readonly Account[]): boolean {
  const account = accounts.find((a) => a.id === c.accountId);
  if (!account) throw new Error(`账户不存在: ${c.accountId}`);
  const transferAccount = extractMaskedTransferSuffix(c.rawDescription);
  return detectTransfer({ transferAccount }, account, accounts).transferStatus === 'auto';
}

function counterpartCase(c: UndoCounterpart, accounts: readonly Account[]): CounterpartCase {
  if (c.transferStatus === 'auto') {
    return stillDetected(c, accounts) ? 'auto_still_detected' : 'auto_not_detected';
  }
  return c.transferStatus;
}

// R12.1：先按这个计划处理另一半（清空配对），再删交易、恢复 pending
export function planUndo(input: UndoInput): UndoPlan {
  const { batchTxs, counterparts, accounts, categories, cards } = input;
  const inBatch = new Set(batchTxs.map((t) => t.id));
  const uncategorized = bySystemKey(categories, 'uncategorized');

  const plans: CounterpartPlan[] = [];
  for (const tx of batchTxs) {
    if (!tx.transferPairId || inBatch.has(tx.transferPairId)) continue;
    const c = counterparts.find((x) => x.id === tx.transferPairId);
    if (!c) throw new Error(`配对的另一半不存在: ${tx.transferPairId}`);

    const kase = counterpartCase(c, accounts);
    if (kase === 'none' || kase === 'auto_still_detected') {
      plans.push({ id: c.id, case: kase, action: 'unpair' });
      continue;
    }

    // 改回未分类，按 R5.1 重算归属人（manual 不动）
    const member = recomputeMember(
      { ...c.primarySplit, accountId: c.accountId, cardLast4: c.cardLast4 },
      uncategorized.id,
      { categories, cards, accounts },
    );
    plans.push({
      id: c.id,
      case: kase,
      action: 'reset',
      transferStatus: 'none',
      primarySplit: {
        categoryId: uncategorized.id,
        categorySource: 'system',
        isPreTax: uncategorized.isPreTaxDefault,
        memberId: member.memberId,
        memberSource: member.memberSource,
      },
    });
  }

  const manualEditedCount = batchTxs.filter((t) => !t.wasPending && manuallyEdited(t)).length;
  const confirmedPendingCount = batchTxs.filter((t) => t.wasPending).length;
  return {
    counterparts: plans,
    prompt: {
      manualEditedCount,
      confirmedPendingCount,
      needsConfirm: manualEditedCount > 0 || confirmedPendingCount > 0,
    },
  };
}
