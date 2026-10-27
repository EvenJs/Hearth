// R6 内部转账：R6.1 识别、R6.2 配对、R6.3 兜底建议（business-rules.md R6）
// 纯函数，不 import 数据库和 Next.js
import { bySystemKey } from './classify';
import { extractMaskedTransferSuffix } from './extract';
import { recomputeMember, type MemberContext } from './member';
import type { EditSplit, EditTx } from './split-edit';
import type { Account, CategorySource, MemberSource, TransferStatus } from './types';

// ---------- R6.1 ----------

export type DetectResult =
  | { transferStatus: 'auto'; transferAccountId: string }
  | { transferStatus: 'none'; transferAccountId: null };

// R6.1：尾部对得上就算。提取的数字以尾号结尾（ANZ 完整账号），或尾号以提取的数字结尾（CBA 4 位）
function suffixMatches(extracted: string, suffix: string): boolean {
  return extracted.endsWith(suffix) || suffix.endsWith(extracted);
}

// R6.1 自动识别。row.transferAccount 是 R2.2 提取的对方账号（已经检查过 FUNDS TFER / TRANSFER 关键词）
// 不能是当前账户自己；没有尾号的账户（现金）跳过；对上多个账户时不认，留给 R6.3
export function detectTransfer(
  row: { transferAccount: string | null },
  account: Account,
  allAccounts: readonly Account[],
): DetectResult {
  const extracted = row.transferAccount;
  if (!extracted) return { transferStatus: 'none', transferAccountId: null };

  const matches = allAccounts.filter(
    (a) => a.id !== account.id && a.numberSuffix && suffixMatches(extracted, a.numberSuffix),
  );
  if (matches.length !== 1) return { transferStatus: 'none', transferAccountId: null };
  return { transferStatus: 'auto', transferAccountId: matches[0].id };
}

// ---------- R6.2、R6.3 共用 ----------

// 配对需要的交易字段（主拆分上的分类）
export type TransferTx = {
  id: string;
  accountId: string;
  date: string; // YYYY-MM-DD
  amountCents: number;
  transferStatus: TransferStatus;
  transferAccountId: string | null; // R6.1 匹配到的对方账户
  transferPairId: string | null;
  categoryId: string;
  categorySource: CategorySource;
  splitCount: number; // R15 拆分数。R6.2 的另一半有多个拆分时不改分类
};

const MAX_DAYS_APART = 2;

// 两个 YYYY-MM-DD 相差几天。只用 Date.UTC 算天数，不经过本地时区
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function withinDays(a: string, b: string): boolean {
  return Math.abs(dayNumber(a) - dayNumber(b)) <= MAX_DAYS_APART;
}

// 金额相反、日期相差 ≤ 2 天
function mirrors(a: TransferTx, b: TransferTx): boolean {
  return a.id !== b.id && a.amountCents === -b.amountCents && withinDays(a.date, b.date);
}

// ---------- R6.2 ----------

export type PairResult = {
  counterpartId: string;
  // 另一半配对后的字段
  counterpart: Pick<TransferTx, 'transferStatus' | 'categoryId' | 'categorySource'>;
  // 另一半是 manual 分类或有多个拆分，没改它，F8 要提示
  manualCategoryKept: boolean;
};

// R6.2：给一笔还没配对的 auto 转账，在对方账户的交易里找另一半
// 恰好 1 笔才配对；0 笔或多笔 → null，不影响它本身是转账
// 调用方负责两边互相写 transfer_pair_id；分类改了的话按 R5.1 重算归属人
export function findPair(
  tx: TransferTx,
  candidates: readonly TransferTx[],
  internalTransferCategoryId: string,
): PairResult | null {
  if (tx.transferStatus !== 'auto' || tx.transferPairId || !tx.transferAccountId) return null;

  const hits = candidates.filter(
    (c) => c.accountId === tx.transferAccountId && c.transferPairId === null && mirrors(tx, c),
  );
  if (hits.length !== 1) return null;
  const c = hits[0];

  // 另一半已经是 auto 转账（两边都识别出来了）→ 不用改
  if (c.transferStatus === 'auto') {
    return {
      counterpartId: c.id,
      counterpart: {
        transferStatus: c.transferStatus,
        categoryId: c.categoryId,
        categorySource: c.categorySource,
      },
      manualCategoryKept: false,
    };
  }

  // 另一半是 manual 分类，或者有多个拆分（用户手动拆的，同 R7.2 跳过多拆分）→ 只配对，什么都不改
  if (c.categorySource === 'manual' || c.splitCount > 1) {
    return {
      counterpartId: c.id,
      counterpart: {
        transferStatus: c.transferStatus,
        categoryId: c.categoryId,
        categorySource: c.categorySource,
      },
      manualCategoryKept: true,
    };
  }

  // 另一半还不是转账（比如 CBA 只有人名，被分成 Uncategorised）→ 改成 auto + 内部转账
  return {
    counterpartId: c.id,
    counterpart: {
      transferStatus: 'auto',
      categoryId: internalTransferCategoryId,
      categorySource: 'system',
    },
    manualCategoryKept: false,
  };
}

// ---------- R6.3 ----------

export type TransferSuggestion = { aId: string; bId: string };

// R6.3：不是转账、还没配对、未分类的交易
function suggestable(t: TransferTx, uncategorizedCategoryId: string): boolean {
  return (
    t.transferStatus === 'none' &&
    t.transferPairId === null &&
    t.categoryId === uncategorizedCategoryId
  );
}

// R6.3 兜底建议：在本家庭其他账户里找金额相反、日期 ≤ 2 天、也是未分类的
// txs 是整个家庭的交易（包括以前导入的）；newIds 是本次导入新插入的交易 id
// 只建议至少一边是新交易的配对：每一对只在后导入的那一边进来时检查一次，拒绝过的两笔旧交易不会再被建议
// 候选和"两边互相只有对方一个候选"都按整个家庭算，旧交易也算候选
// newIds 不传时所有交易都当成新的（M2 的用法）
// 调用方把两边标成 suggested 并互相写 transfer_pair_id。结果按输入顺序，aId 是先出现的那笔
export function suggestTransfers(
  txs: readonly TransferTx[],
  uncategorizedCategoryId: string,
  newIds?: ReadonlySet<string>,
): TransferSuggestion[] {
  const isNew = (t: TransferTx) => !newIds || newIds.has(t.id);
  const pool = txs.filter((t) => suggestable(t, uncategorizedCategoryId));
  const candidatesOf = new Map(
    pool.map((t) => [t.id, pool.filter((o) => o.accountId !== t.accountId && mirrors(t, o))]),
  );

  const out: TransferSuggestion[] = [];
  const used = new Set<string>();
  for (const a of pool) {
    if (used.has(a.id)) continue;
    const aCands = candidatesOf.get(a.id) ?? [];
    if (aCands.length !== 1) continue;
    const b = aCands[0];
    const bCands = candidatesOf.get(b.id) ?? [];
    if (bCands.length !== 1 || bCands[0].id !== a.id) continue;
    if (!isNew(a) && !isNew(b)) continue;
    out.push({ aId: a.id, bId: b.id });
    used.add(a.id).add(b.id);
  }
  return out;
}

// R6.3 在 F8 里确认或拒绝建议转账，两边一起改
export type SuggestionTx = EditTx & {
  id: string;
  transferPairId: string | null;
  splits: readonly EditSplit[];
};

// 一边要写的字段：transaction 上的两个字段 + 要改的拆分（拒绝时不改拆分，为空）
export type SuggestionUpdate = {
  transactionId: string;
  transferStatus: 'confirmed' | 'none';
  transferPairId: string | null;
  splits: EditSplit[];
};

export type ResolveResult =
  { ok: true; a: SuggestionUpdate; b: SuggestionUpdate } | { ok: false; message: string };

// R6.3 确认：confirmed、内部转账、category_source = manual（R7.2 不会覆盖）、配对保留
// is_pre_tax 按内部转账的默认值（R7）；归属人按 R5.1 重算，未分类 → 内部转账时结果不变
function confirmSide(t: SuggestionTx, ctx: MemberContext): SuggestionUpdate {
  const internal = bySystemKey(ctx.categories, 'internal_transfer');
  const splits = t.splits.map((s) => ({
    ...s,
    categoryId: internal.id,
    categorySource: 'manual' as const,
    isPreTax: internal.isPreTaxDefault,
    ...recomputeMember(
      {
        memberId: s.memberId,
        memberSource: s.memberSource,
        accountId: t.accountId,
        cardLast4: t.cardLast4,
      },
      internal.id,
      ctx,
    ),
  }));
  return {
    transactionId: t.id,
    transferStatus: 'confirmed',
    transferPairId: t.transferPairId,
    splits,
  };
}

// R6.3 拒绝：none、配对清空、分类和归属人不变
function rejectSide(t: SuggestionTx): SuggestionUpdate {
  return {
    transactionId: t.id,
    transferStatus: 'none',
    transferPairId: null,
    splits: [],
  };
}

// R6.3：a、b 是互相配对的两笔 suggested 交易，从哪一边发起都行
// 两边有一边有多个拆分时不能确认（规则文档没写，先报错）
export function resolveSuggestion(
  a: SuggestionTx,
  b: SuggestionTx,
  action: 'confirm' | 'reject',
  ctx: MemberContext,
): ResolveResult {
  if (a.transferStatus !== 'suggested' || b.transferStatus !== 'suggested') {
    return { ok: false, message: '不是建议转账' };
  }
  if (a.transferPairId !== b.id || b.transferPairId !== a.id) {
    return { ok: false, message: '两笔交易没有互相配对' };
  }
  if (action === 'reject') return { ok: true, a: rejectSide(a), b: rejectSide(b) };
  if (a.splits.length !== 1 || b.splits.length !== 1) {
    return { ok: false, message: '有拆分的交易不能确认为内部转账，先删掉拆分' };
  }
  return { ok: true, a: confirmSide(a, ctx), b: confirmSide(b, ctx) };
}

// ---------- R12 第 6 步：R6.2 整个家庭配对，然后 R6.3 建议 ----------

// R6.2：以前导入的 auto 转账，表里没存对方账户，完整账号也已经脱敏了
// 和 R12.1 一样从脱敏后的描述重跑 R6.1：****1234 当成 4 位尾号。尾号对上多个家庭账户时认不出 → null
export function storedTransferAccountId(
  maskedDescription: string,
  account: Account,
  allAccounts: readonly Account[],
): string | null {
  const transferAccount = extractMaskedTransferSuffix(maskedDescription);
  return detectTransfer({ transferAccount }, account, allAccounts).transferAccountId;
}

// 家庭里还没配对的 confirmed 交易 + 主拆分上 R5.1 要用的字段
export type HouseholdTransferTx = TransferTx & {
  cardLast4: string | null;
  memberId: string;
  memberSource: MemberSource;
};

// R6.2 另一半要改成内部转账时写的字段（transaction.transfer_status + 主拆分）
export type CounterpartUpdate = {
  transferStatus: 'auto';
  categoryId: string;
  categorySource: 'system';
  isPreTax: boolean;
  memberId: string;
  memberSource: MemberSource;
};

export type PairPlan = {
  aId: string; // 去找另一半的那笔 auto 转账
  bId: string; // 另一半
  counterpartUpdate: CounterpartUpdate | null; // null = 另一半不用改
  manualCategoryKept: boolean; // 另一半是 manual 或多个拆分，没改，F8 提示
};

export type TransferPlan = {
  pairs: PairPlan[];
  suggestions: TransferSuggestion[];
};

const byDateThenId = (a: TransferTx, b: TransferTx) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// R12 第 6 步。txs：整个家庭还没配对的 confirmed 交易（以前导入的 transferAccountId 用 storedTransferAccountId 补上）
// newIds：本次导入新插入的交易 id，R6.3 只从它们出发
// R6.2 按日期从早到晚处理每笔还没配对的 auto 转账，配上的两笔后面不再参与；然后在配对后的状态上跑 R6.3
// 调用方负责两边互相写 transfer_pair_id、写 counterpartUpdate、把建议的两边标成 suggested
export function planTransfers(
  txs: readonly HouseholdTransferTx[],
  newIds: ReadonlySet<string>,
  ctx: MemberContext,
): TransferPlan {
  const internal = bySystemKey(ctx.categories, 'internal_transfer');
  const uncategorized = bySystemKey(ctx.categories, 'uncategorized');
  const state = new Map(txs.map((t) => [t.id, { ...t }]));
  const all = [...state.values()];

  const pairs: PairPlan[] = [];
  const autos = all
    .filter((t) => t.transferStatus === 'auto' && t.transferPairId === null)
    .sort(byDateThenId);
  for (const a of autos) {
    if (a.transferPairId !== null) continue; // 已经被前面的转账当成另一半配上了
    const found = findPair(a, all, internal.id);
    if (!found) continue;
    const b = state.get(found.counterpartId)!;

    let counterpartUpdate: CounterpartUpdate | null = null;
    if (b.transferStatus !== 'auto' && found.counterpart.transferStatus === 'auto') {
      // 另一半改成内部转账，归属人按 R5.1 重算（manual 不动）
      const member = recomputeMember(
        {
          memberId: b.memberId,
          memberSource: b.memberSource,
          accountId: b.accountId,
          cardLast4: b.cardLast4,
        },
        internal.id,
        ctx,
      );
      counterpartUpdate = {
        transferStatus: 'auto',
        categoryId: internal.id,
        categorySource: 'system',
        isPreTax: internal.isPreTaxDefault,
        ...member,
      };
      Object.assign(b, counterpartUpdate);
    }
    a.transferPairId = b.id;
    b.transferPairId = a.id;
    pairs.push({
      aId: a.id,
      bId: b.id,
      counterpartUpdate,
      manualCategoryKept: found.manualCategoryKept,
    });
  }

  return {
    pairs,
    suggestions: suggestTransfers(all, uncategorized.id, newIds),
  };
}

// ---------- R6.4 保存带尾号的账户时重新识别 ----------

// 本家庭的旧交易：脱敏后的描述 + 拆分（第 1 个是主拆分）
export type RedetectTx = {
  id: string;
  accountId: string;
  rawDescription: string; // R2.3 脱敏后
  cardLast4: string | null; // R5.1 重算归属人用
  transferStatus: TransferStatus;
  transferPairId: string | null;
  splits: readonly EditSplit[];
};

// 认成转账后要写的：transaction.transfer_status + 主拆分
export type RedetectUpdate = {
  transactionId: string;
  transferStatus: 'auto';
  split: EditSplit;
};

export type RedetectPlan = {
  updates: RedetectUpdate[]; // 弹窗里的 N
  keptCount: number; // 对上了，但分类是 manual 或有多个拆分，不改（弹窗里的 M）
};

// R6.4 第 1 到 3 步。account 是正在保存的账户（新的尾号），householdAccounts 是本家庭的账户
// （可以还是保存前的旧值，同 id 的以 account 为准；新建时可以不含 account）
// 第 4 步 R6.2 配对、弹窗和事务由调用方做
export function planTransferRedetect(
  account: Account,
  candidates: readonly RedetectTx[],
  householdAccounts: readonly Account[],
  ctx: Omit<MemberContext, 'accounts'>,
): RedetectPlan {
  const plan: RedetectPlan = { updates: [], keptCount: 0 };
  if (!account.numberSuffix) return plan; // 尾号是空的不触发

  const accounts = [...householdAccounts.filter((a) => a.id !== account.id), account];
  const memberCtx: MemberContext = { ...ctx, accounts };
  const internal = bySystemKey(ctx.categories, 'internal_transfer');
  const uncategorized = bySystemKey(ctx.categories, 'uncategorized');

  for (const tx of candidates) {
    // 第 1 步：其他账户里 none、没配对的（suggested、auto、confirmed 和 R16.7 只配对的都不算）
    if (tx.accountId === account.id) continue;
    if (tx.transferStatus !== 'none' || tx.transferPairId !== null) continue;

    // 第 2 步：脱敏后的描述重跑 R2.2、R6.1，只看是不是唯一对上这个账户
    const txAccount = accounts.find((a) => a.id === tx.accountId);
    if (!txAccount) throw new Error(`账户不存在: ${tx.accountId}`);
    if (storedTransferAccountId(tx.rawDescription, txAccount, accounts) !== account.id) continue;

    // 第 3 步：多拆分、manual 的不改，计数
    const [split] = tx.splits;
    if (!split) continue;
    if (tx.splits.length > 1 || split.categorySource === 'manual') {
      plan.keptCount++;
      continue;
    }
    // 表格第 1 行：rule 来源或未分类的才改（和 R7.2 同一个范围）
    const changeable =
      split.categorySource === 'rule' ||
      (split.categorySource === 'system' && split.categoryId === uncategorized.id);
    if (!changeable) continue;

    const member = recomputeMember(
      {
        memberId: split.memberId,
        memberSource: split.memberSource,
        accountId: tx.accountId,
        cardLast4: tx.cardLast4,
      },
      internal.id,
      memberCtx,
    );
    plan.updates.push({
      transactionId: tx.id,
      transferStatus: 'auto',
      split: {
        id: split.id,
        categoryId: internal.id,
        categorySource: 'system',
        isPreTax: internal.isPreTaxDefault,
        ...member,
      },
    });
  }
  return plan;
}
