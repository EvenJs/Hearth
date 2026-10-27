// 手动录入（F3）：R8.1 初始状态、R17.1 字段、R17.2 猜分类和常用分类、R17.3 来源、
// R17.5 编辑和删除、R17.6 可能重复
// 函数只算出要写的字段，入库（一个事务）由 src/server/ 做
// 纯函数，不 import 数据库和 Next.js
import { parseSplitAmountInput } from '@/lib/transactions/split-form';
import { bySystemKey, classify } from './classify';
import { maskLongDigits } from './extract';
import { cleanMerchant } from './merchant';
import { resolveMember, type MemberContext, type MemberResult } from './member';
import { initialStatus, type TransactionStatus } from './pending';
import { daysBetween } from './periods';
import {
  isSelectableCategory,
  typeOfCategory,
  type EditCategory,
  type TransactionType,
} from './split-edit';
import type {
  Account,
  CategoryRule,
  CategorySource,
  Member,
  MemberSource,
  TransferStatus,
} from './types';

// ---------- 类型 ----------

// 表单上的"支出 / 收入"切换
export type EntryKind = 'expense' | 'income';

// 账户归档不在 Account 类型里，这里单独加，不传当成没归档
export type ManualAccount = Account & { isArchived?: boolean };

// accounts、categories 换成带归档字段的版本，仍然能当 MemberContext 传给 resolveMember
export type ManualContext = Omit<MemberContext, 'accounts' | 'categories'> & {
  members: readonly Member[];
  accounts: readonly ManualAccount[];
  categories: readonly EditCategory[];
  rules: readonly CategoryRule[];
  today: string; // todayInMelbourne()
};

// 表单值，金额和日期是用户填的字符串
export type ManualInput = {
  amount: string; // 正数（元），符号按 kind 定
  kind: EntryKind;
  description: string;
  accountId: string;
  date: string; // YYYY-MM-DD
  categoryId: string | null; // null = 未分类
  categoryGuessed: boolean; // 表单上的分类是猜的、用户没点过
  memberId: string | null; // null = 自动
};

export type ManualField =
  'amount' | 'description' | 'accountId' | 'date' | 'categoryId' | 'memberId';
export type ManualFieldErrors = Partial<Record<ManualField, string>>;

// 要写入 transaction 的字段（created_by、id、时间戳由数据层填）
export type ManualTransaction = {
  accountId: string;
  date: string;
  amountCents: number;
  rawDescription: string;
  merchant: string;
  status: TransactionStatus;
  cardLast4: null;
  balanceCents: null;
  dedupeKey: null;
  importBatchId: null;
  transferStatus: TransferStatus;
  source: 'manual';
};

// 要写入的主拆分（R15.1）
export type ManualPrimarySplit = {
  isPrimary: true;
  amountCents: number;
  categoryId: string;
  categorySource: CategorySource;
  isPreTax: boolean;
  memberId: string;
  memberSource: MemberSource;
};

export type BuildResult =
  | { ok: true; transaction: ManualTransaction; split: ManualPrimarySplit }
  | { ok: false; errors: ManualFieldErrors };

// ---------- 字段校验（R17.1） ----------

const MAX_DESCRIPTION = 100;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(date: string): boolean {
  const m = ISO_DATE.exec(date);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= days;
}

// R17.1：默认今天，不能晚于今天，往前不限。YYYY-MM-DD 字符串直接比较
function checkDate(date: string, today: string): string | null {
  if (!isRealDate(date)) return '日期不对';
  if (date > today) return '日期不能晚于今天';
  return null;
}

// R17.1 + R2.3 + R3：去首尾空格 → 脱敏 → 清洗 merchant
function checkDescription(
  description: string,
): { ok: true; rawDescription: string; merchant: string } | { ok: false; message: string } {
  const trimmed = description.trim();
  if (trimmed === '') return { ok: false, message: '请填描述' };
  if (trimmed.length > MAX_DESCRIPTION) {
    return { ok: false, message: `描述最长 ${MAX_DESCRIPTION} 个字` };
  }
  const rawDescription = maskLongDigits(trimmed);
  return { ok: true, rawDescription, merchant: cleanMerchant(rawDescription) };
}

// R17.1：本家庭没归档的账户
function findAccount(accountId: string, ctx: ManualContext): ManualAccount | null {
  const a = ctx.accounts.find((x) => x.id === accountId);
  return a && !a.isArchived ? a : null;
}

// R17.1 分类可选项：R16.3 的下拉再按切换过滤
// 支出 → expense 分类加现金支出、银行费用；收入 → income 分类。未分类用 null 表示，不在这里
// R16.3：一级归档后它下面的二级也不能选
export function isAllowedForKind(
  c: EditCategory,
  kind: EntryKind,
  categories: readonly EditCategory[],
): boolean {
  if (!isSelectableCategory(c)) return false;
  if (c.parentId !== null) {
    const parent = categories.find((p) => p.id === c.parentId);
    if (!parent || parent.isArchived) return false;
  }
  return typeOfCategory(c) === kind;
}

const signed = (cents: number, kind: EntryKind) => (kind === 'expense' ? -cents : cents);
const kindOf = (amountCents: number): EntryKind => (amountCents < 0 ? 'expense' : 'income');

// ---------- R17.2 猜分类 ----------

export type CategoryGuess = {
  categoryId: string;
  categorySource: CategorySource;
};

// R17.2：对清洗后的 merchant 跑 R7 第 2、3 步。没命中、类型和切换不一致、不能选 → null
// 系统规则命中记 system，用户规则命中记 rule（R7）
export function guessCategory(
  description: string,
  kind: EntryKind,
  rules: readonly CategoryRule[],
  categories: readonly EditCategory[],
): CategoryGuess | null {
  const trimmed = description.trim();
  if (trimmed === '') return null;
  const merchant = cleanMerchant(maskLongDigits(trimmed));

  // 手动录入不跑 R6.1（R17.1），所以第 1 步永远不命中
  const result = classify({ merchant, isInternalTransfer: false }, rules, categories);
  const category = categories.find((c) => c.id === result.categoryId)!;
  if (category.systemKey === 'uncategorized') return null;
  if (!isAllowedForKind(category, kind, categories)) return null;
  return {
    categoryId: result.categoryId,
    categorySource: result.categorySource,
  };
}

// ---------- R17.1、R17.3、R8.1 新建 ----------

// R17.3 分类来源：猜的没动 → 猜的来源（rule，系统规则是 system）；自己选 → manual；没选 → system
// 服务端按描述重新猜一次，和表单上的不一致（描述改过、规则变了）就当成用户选的
function categorySourceFor(
  input: ManualInput,
  categoryId: string,
  ctx: ManualContext,
): CategorySource {
  if (!input.categoryGuessed) return 'manual';
  const guess = guessCategory(input.description, input.kind, ctx.rules, ctx.categories);
  return guess?.categoryId === categoryId ? guess.categorySource : 'manual';
}

// R17.1 新建一笔手动交易和主拆分。字段错误一次全部返回
export function buildManualTransaction(input: ManualInput, ctx: ManualContext): BuildResult {
  const errors: ManualFieldErrors = {};

  const amount = parseSplitAmountInput(input.amount);
  if (!amount.ok) errors.amount = amount.message;

  const description = checkDescription(input.description);
  if (!description.ok) errors.description = description.message;

  const account = findAccount(input.accountId, ctx);
  if (!account) errors.accountId = '请选账户';

  const dateError = checkDate(input.date, ctx.today);
  if (dateError) errors.date = dateError;

  if (input.categoryId !== null) {
    const c = ctx.categories.find((x) => x.id === input.categoryId);
    if (!c || !isAllowedForKind(c, input.kind, ctx.categories))
      errors.categoryId = '不能选这个分类';
  }

  if (input.memberId !== null && !ctx.members.some((m) => m.id === input.memberId)) {
    errors.memberId = '归属人不存在';
  }

  if (!amount.ok || !description.ok || !account || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const amountCents = signed(amount.cents, input.kind);

  // R17.3 分类
  const category =
    input.categoryId === null
      ? bySystemKey(ctx.categories, 'uncategorized')
      : ctx.categories.find((c) => c.id === input.categoryId)!;
  const categorySource: CategorySource =
    input.categoryId === null ? 'system' : categorySourceFor(input, category.id, ctx);

  // R17.3 归属人：自动 → R5（没有卡号），自己选 → manual
  const member = resolveMember(
    {
      accountId: account.id,
      cardLast4: null,
      categoryId: category.id,
      manualMemberId: input.memberId,
    },
    ctx,
  );

  return {
    ok: true,
    transaction: {
      accountId: account.id,
      date: input.date,
      amountCents,
      rawDescription: description.rawDescription,
      merchant: description.merchant,
      status: initialStatus(account), // R8.1
      cardLast4: null,
      balanceCents: null,
      dedupeKey: null,
      importBatchId: null,
      transferStatus: 'none', // R17.1 不跑 R6.1
      source: 'manual',
    },
    split: {
      isPrimary: true,
      amountCents,
      categoryId: category.id,
      categorySource,
      isPreTax: category.isPreTaxDefault, // R7
      ...member,
    },
  };
}

// ---------- R17.2 常用分类 ----------

// 本家庭 source = manual 交易的主拆分，数据层只传 R16.3 能选的分类
export type RecentManualUse = {
  categoryId: string;
  categoryType: TransactionType; // R16.5 typeOfCategory
  date: string; // 交易日期 YYYY-MM-DD
  createdAt: Date;
};

const WINDOW_DAYS = 90;

// R17.2：最近 90 天（今天往前 90 天也算，91 天不算），和切换同类型，
// 按次数从多到少，次数一样按最近一次用的（交易日期，再按 created_at），取前 n 个，不够不补
export function frequentCategories(
  recent: readonly RecentManualUse[],
  kind: EntryKind,
  today: string,
  n: number,
): string[] {
  const stats = new Map<string, { count: number; lastDate: string; lastCreated: number }>();
  for (const r of recent) {
    if (r.categoryType !== kind) continue;
    const age = daysBetween(r.date, today);
    if (age < 0 || age > WINDOW_DAYS) continue;

    const s = stats.get(r.categoryId) ?? {
      count: 0,
      lastDate: '',
      lastCreated: 0,
    };
    s.count++;
    const created = r.createdAt.getTime();
    if (r.date > s.lastDate || (r.date === s.lastDate && created > s.lastCreated)) {
      s.lastDate = r.date;
      s.lastCreated = created;
    }
    stats.set(r.categoryId, s);
  }

  return [...stats.entries()]
    .sort(
      ([, a], [, b]) =>
        b.count - a.count || b.lastDate.localeCompare(a.lastDate) || b.lastCreated - a.lastCreated,
    )
    .slice(0, n)
    .map(([id]) => id);
}

// ---------- R17.5 能不能编辑、删除 ----------

export type ManualEditableTx = {
  source: 'csv' | 'manual' | 'receipt';
  importBatchId: string | null;
  transferPairId: string | null;
};

export type EditPermission = {
  canEdit: boolean;
  canDelete: boolean;
  reason: string | null; // 有一样不能时给出原因
};

// R17.5：只有 source = manual 且 import_batch_id 为空的能编辑、删除整笔
// 有 transfer_pair_id 的能编辑、不能删除（R6.3 建议先在 F8 拒绝）
export function canEditManual(tx: ManualEditableTx): EditPermission {
  if (tx.source !== 'manual') {
    return {
      canEdit: false,
      canDelete: false,
      reason: '导入的交易只能改分类、归属人、拆分和备注',
    };
  }
  if (tx.importBatchId !== null) {
    return {
      canEdit: false,
      canDelete: false,
      reason: '这笔已经被导入确认，只能改分类、归属人、拆分和备注',
    };
  }
  if (tx.transferPairId !== null) {
    return {
      canEdit: true,
      canDelete: false,
      reason: '这笔和另一笔配成了转账，先在流水里拒绝建议再删',
    };
  }
  return { canEdit: true, canDelete: true, reason: null };
}

// ---------- R17.5 编辑 ----------

export type ManualEditTx = ManualEditableTx & {
  accountId: string;
  date: string;
  amountCents: number;
  rawDescription: string;
  merchant: string;
  status: TransactionStatus;
};

export type ManualSplit = {
  id: string;
  isPrimary: boolean;
  amountCents: number;
  categoryId: string;
  categorySource: CategorySource;
  memberId: string;
  memberSource: MemberSource;
};

// 没传的字段不改。kind 只用来拦住改符号（R17.5）
export type ManualEdit = {
  amount?: string;
  kind?: EntryKind;
  description?: string;
  accountId?: string;
  date?: string;
};

// 只返回真的变了的字段
export type ManualTxChanges = Partial<
  Pick<
    ManualEditTx,
    'accountId' | 'date' | 'amountCents' | 'rawDescription' | 'merchant' | 'status'
  >
>;
export type ManualSplitChange = {
  id: string;
  amountCents?: number;
} & Partial<MemberResult>;

export type EditManualResult =
  | { ok: true; transaction: ManualTxChanges; splits: ManualSplitChange[] }
  | { ok: false; errors: ManualFieldErrors & { form?: string } };

// R17.5：改日期、金额、描述、账户，规则同 R17.1
// - 不能改符号；改金额只在只有主拆分时可以，主拆分跟着变
// - 改描述重新清洗 merchant，不重新猜分类
// - 改账户：状态按新账户走 R8.1，不是 manual 的归属人按 R5 用新账户重算（所有拆分）
export function applyManualEdit(
  tx: ManualEditTx,
  splits: readonly ManualSplit[],
  edit: ManualEdit,
  ctx: ManualContext,
): EditManualResult {
  const permission = canEditManual(tx);
  if (!permission.canEdit) return { ok: false, errors: { form: permission.reason! } };

  const kind = kindOf(tx.amountCents);
  if (edit.kind !== undefined && edit.kind !== kind) {
    return {
      ok: false,
      errors: { amount: '不能把支出改成收入（或反过来），要改就删掉重记' },
    };
  }

  const errors: ManualFieldErrors = {};
  const changes: ManualTxChanges = {};
  const splitChanges = new Map<string, ManualSplitChange>();
  const change = (id: string, patch: Omit<ManualSplitChange, 'id'>) =>
    splitChanges.set(id, { ...(splitChanges.get(id) ?? { id }), ...patch });

  // 金额
  if (edit.amount !== undefined) {
    const amount = parseSplitAmountInput(edit.amount);
    if (!amount.ok) {
      errors.amount = amount.message;
    } else {
      const amountCents = signed(amount.cents, kind);
      if (amountCents !== tx.amountCents) {
        const primary = splits.find((s) => s.isPrimary);
        if (splits.length > 1 || !primary) {
          errors.amount = '有多个拆分时不能改金额，先删掉拆分';
        } else {
          changes.amountCents = amountCents;
          change(primary.id, { amountCents });
        }
      }
    }
  }

  // 描述
  if (edit.description !== undefined) {
    const d = checkDescription(edit.description);
    if (!d.ok) errors.description = d.message;
    else if (d.rawDescription !== tx.rawDescription) {
      changes.rawDescription = d.rawDescription;
      if (d.merchant !== tx.merchant) changes.merchant = d.merchant;
    }
  }

  // 日期
  if (edit.date !== undefined) {
    const dateError = checkDate(edit.date, ctx.today);
    if (dateError) errors.date = dateError;
    else if (edit.date !== tx.date) changes.date = edit.date;
  }

  // 账户
  if (edit.accountId !== undefined && edit.accountId !== tx.accountId) {
    const account = findAccount(edit.accountId, ctx);
    if (!account) {
      errors.accountId = '请选账户';
    } else {
      changes.accountId = account.id;
      const status = initialStatus(account); // R8.1
      if (status !== tx.status) changes.status = status;

      for (const s of splits) {
        if (s.memberSource === 'manual') continue;
        const m = resolveMember(
          { accountId: account.id, cardLast4: null, categoryId: s.categoryId },
          ctx,
        );
        if (m.memberId !== s.memberId || m.memberSource !== s.memberSource) change(s.id, m);
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, transaction: changes, splits: [...splitChanges.values()] };
}

// ---------- R17.6 可能重复 ----------

export type PossibleDuplicate = {
  transactionId: string;
  pendingIds: readonly string[];
};

// R17.6：pendingStates 是 warnings 里提到的 pending 现在的状态，已经删掉的不在里面
// 每条记录里还在、还是 pending 的那几笔加上银行那笔都显示；一笔都不剩就整条不显示
export function activeDuplicates(
  warnings: readonly PossibleDuplicate[],
  pendingStates: ReadonlyMap<string, TransactionStatus>,
): string[] {
  const ids = new Set<string>();
  for (const w of warnings) {
    const alive = w.pendingIds.filter((id) => pendingStates.get(id) === 'pending');
    if (alive.length === 0) continue;
    ids.add(w.transactionId);
    for (const id of alive) ids.add(id);
  }
  return [...ids];
}
