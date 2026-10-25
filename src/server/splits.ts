// F8 交易详情里的拆分（M4-6）：拆出一部分（R15.2）、改和删除（R15.3）
// 金额怎么变由 src/lib/rules/split.ts 算，分类、归属人怎么变由 src/lib/rules/split-edit.ts 算
// 这里负责读、校验、在一个事务里写回，写完检查 R15.1（合计 = 交易金额、恰好一个主拆分）
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { transaction, transactionSplit } from '@/db/schema';
import {
  addSplit as planAddSplit,
  removeSplit as planRemoveSplit,
  updateSplitAmount,
  type SplitRow,
  type SplitTx,
} from '@/lib/rules/split';
import { changeCategory, changeMember, isSelectableCategory } from '@/lib/rules/split-edit';
import type { CategorySource, MemberSource, TransferStatus } from '@/lib/rules/types';
import type { HouseholdContext } from './context';
import { isActiveMember } from './members';
import { loadEditContext, type DbTx } from './transactions';

export type SplitWriteResult = { ok: true; splitId: string } | { ok: false; message: string };

export type AddSplitInput = {
  amountCents: number; // 用户填的正数，按交易符号转换（R15.2）
  categoryId: string;
  memberId?: string | null; // 不选就按 R5 算
  note?: string | null;
};

// 只传要改的字段。amountCents 是用户填的正数；note 传 null 或空字符串是清空
export type UpdateSplitInput = {
  amountCents?: number;
  categoryId?: string;
  memberId?: string;
  note?: string | null;
};

const INVALID = { ok: false, message: '参数不合法' } as const;
const NOT_FOUND = { ok: false, message: '找不到这个拆分' } as const;
const BAD_CATEGORY = { ok: false, message: '不能选这个分类' } as const;
const BAD_MEMBER = { ok: false, message: '不能选这个归属人' } as const;

// 备注：去掉首尾空格，空的当成没有
const noteSchema = z
  .string()
  .max(200)
  .nullish()
  .transform((v) => {
    const s = v?.trim();
    return s ? s : null;
  });

// 金额只检查是正整数，大小关系（< 主拆分）交给 R15.2 / R15.3 的纯函数
const amountSchema = z.number().int().positive();

const addSchema = z.object({
  amountCents: amountSchema,
  categoryId: z.uuid(),
  memberId: z.uuid().nullish(),
  note: noteSchema,
});

const updateSchema = z
  .object({
    amountCents: amountSchema.optional(),
    categoryId: z.uuid().optional(),
    memberId: z.uuid().optional(),
    note: noteSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined) || 'note' in v, {
    message: '没有要改的字段',
  });

type StoredSplit = SplitRow & { id: string };

type LoadedTx = Omit<SplitTx, 'splits'> & {
  id: string;
  transferStatus: TransferStatus;
  splits: StoredSplit[];
};

// 锁住交易和它所有的拆分，读出 R15 和 R5 要用的字段
async function lockTransaction(
  tx: DbTx,
  ctx: HouseholdContext,
  transactionId: string,
): Promise<LoadedTx | null> {
  const [row] = await tx
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      cardLast4: transaction.cardLast4,
      amountCents: transaction.amountCents,
      transferStatus: transaction.transferStatus,
    })
    .from(transaction)
    .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, ctx.householdId)))
    .for('update');
  if (!row) return null;

  const splits = await tx
    .select({
      id: transactionSplit.id,
      isPrimary: transactionSplit.isPrimary,
      amountCents: transactionSplit.amountCents,
      categoryId: transactionSplit.categoryId,
      categorySource: transactionSplit.categorySource,
      memberId: transactionSplit.memberId,
      memberSource: transactionSplit.memberSource,
      isPreTax: transactionSplit.isPreTax,
      note: transactionSplit.note,
    })
    .from(transactionSplit)
    .where(
      and(
        eq(transactionSplit.transactionId, row.id),
        eq(transactionSplit.householdId, ctx.householdId),
      ),
    )
    .orderBy(asc(transactionSplit.id))
    .for('update');

  return {
    ...row,
    splits: splits.map((s) => ({
      ...s,
      categorySource: s.categorySource as CategorySource,
      memberSource: s.memberSource as MemberSource,
    })),
  };
}

// 拆分 id → 交易 id（只在本家庭里找）
async function transactionIdOfSplit(
  tx: DbTx,
  ctx: HouseholdContext,
  splitId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ transactionId: transactionSplit.transactionId })
    .from(transactionSplit)
    .where(
      and(eq(transactionSplit.id, splitId), eq(transactionSplit.householdId, ctx.householdId)),
    );
  return row?.transactionId ?? null;
}

// R15.1：合计 = 交易金额，恰好一个主拆分，没有 0 金额。写库前检查，不满足说明纯函数有 bug，抛错回滚
function assertInvariant(t: LoadedTx, splits: readonly SplitRow[]): void {
  const sum = splits.reduce((s, x) => s + x.amountCents, 0);
  const primaries = splits.filter((s) => s.isPrimary).length;
  if (sum !== t.amountCents || primaries !== 1 || splits.some((s) => s.amountCents === 0)) {
    throw new Error(`R15.1 不满足：合计 ${sum}，交易 ${t.amountCents}，主拆分 ${primaries} 个`);
  }
}

// 把新的拆分列表写回：id 为 null 的新建，列表里没有的删除，其他的有变化才更新
// 返回新建拆分的 id（没有新建时为 null）
async function writeSplits(
  tx: DbTx,
  ctx: HouseholdContext,
  t: LoadedTx,
  next: readonly SplitRow[],
): Promise<string | null> {
  assertInvariant(t, next);

  const keep = new Set(next.flatMap((s) => (s.id ? [s.id] : [])));
  const removed = t.splits.filter((s) => !keep.has(s.id)).map((s) => s.id);
  if (removed.length > 0) {
    await tx
      .delete(transactionSplit)
      .where(
        and(
          inArray(transactionSplit.id, removed),
          eq(transactionSplit.householdId, ctx.householdId),
        ),
      );
  }

  const fields = (s: SplitRow) => ({
    amountCents: s.amountCents,
    categoryId: s.categoryId,
    categorySource: s.categorySource,
    memberId: s.memberId,
    memberSource: s.memberSource,
    isPreTax: s.isPreTax,
    note: s.note,
  });

  for (const s of next) {
    if (s.id === null) continue;
    const old = t.splits.find((o) => o.id === s.id)!;
    if (JSON.stringify(fields(old)) === JSON.stringify(fields(s))) continue;
    await tx
      .update(transactionSplit)
      .set(fields(s))
      .where(and(eq(transactionSplit.id, s.id), eq(transactionSplit.householdId, ctx.householdId)));
  }

  let createdId: string | null = null;
  for (const s of next) {
    if (s.id !== null) continue;
    const [row] = await tx
      .insert(transactionSplit)
      .values({
        householdId: ctx.householdId,
        transactionId: t.id,
        isPrimary: s.isPrimary,
        ...fields(s),
      })
      .returning({ id: transactionSplit.id });
    createdId = row.id;
  }
  return createdId;
}

// R16.2：auto、confirmed 转账的分类不能改，所以也不能拆出别的分类
function isLockedTransfer(status: TransferStatus): boolean {
  return status === 'auto' || status === 'confirmed';
}

// R15.2 拆出一部分：主拆分减去这部分，新拆分 category_source = manual，
// 归属人选了就是 manual，没选按 R5；is_pre_tax 按新分类默认
export async function addSplit(
  ctx: HouseholdContext,
  transactionId: string,
  input: AddSplitInput,
): Promise<SplitWriteResult> {
  if (!z.uuid().safeParse(transactionId).success) return INVALID;
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.some((i) => i.path[0] === 'amountCents')
      ? { ok: false, message: '拆出金额必须大于 0' }
      : INVALID;
  }
  const { amountCents, categoryId, memberId, note } = parsed.data;
  if (memberId && !(await isActiveMember(ctx, memberId))) return BAD_MEMBER;

  return db.transaction(async (tx) => {
    const t = await lockTransaction(tx, ctx, transactionId);
    if (!t) return { ok: false, message: '找不到这笔交易' };
    if (isLockedTransfer(t.transferStatus)) {
      return { ok: false, message: '内部转账不能拆分' };
    }

    const editCtx = await loadEditContext(tx, ctx);
    const c = editCtx.categories.find((x) => x.id === categoryId);
    if (!c || !isSelectableCategory(c)) return BAD_CATEGORY; // R16.3

    const r = planAddSplit(t, { amountCents, categoryId, memberId, note }, editCtx);
    if (!r.ok) return r;
    const createdId = await writeSplits(tx, ctx, t, r.splits);
    return { ok: true, splitId: createdId! };
  });
}

// R15.3 改拆分：金额（只能改非主拆分，差额从主拆分补或扣）、分类（R16.4，R5.1 重算归属人）、
// 归属人（manual）、备注。主拆分可以改分类、归属人、备注，不能改金额
// 同时改分类和归属人时，先改分类，再把归属人设成手动指定的
export async function updateSplit(
  ctx: HouseholdContext,
  splitId: string,
  input: UpdateSplitInput,
): Promise<SplitWriteResult> {
  if (!z.uuid().safeParse(splitId).success) return INVALID;
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.some((i) => i.path[0] === 'amountCents')
      ? { ok: false, message: '拆分金额必须大于 0' }
      : INVALID;
  }
  const v = parsed.data;
  if (v.memberId !== undefined && !(await isActiveMember(ctx, v.memberId))) return BAD_MEMBER;

  return db.transaction(async (tx) => {
    const transactionId = await transactionIdOfSplit(tx, ctx, splitId);
    if (!transactionId) return NOT_FOUND;
    const t = await lockTransaction(tx, ctx, transactionId);
    if (!t) return NOT_FOUND;

    let splits: SplitRow[] = t.splits.map((s) => ({ ...s }));

    if (v.amountCents !== undefined) {
      const r = updateSplitAmount({ ...t, splits }, splitId, v.amountCents);
      if (!r.ok) return r;
      splits = r.splits;
    }

    const current = splits.find((s) => s.id === splitId)!;
    let edited: SplitRow = current;

    if (v.categoryId !== undefined) {
      const editCtx = await loadEditContext(tx, ctx);
      // R16.2 转账不能改分类、R16.3 不能选的分类，都由 changeCategory 返回错误
      const r = changeCategory(
        {
          ...current,
          id: splitId,
          accountId: t.accountId,
          cardLast4: t.cardLast4,
          transferStatus: t.transferStatus,
        },
        v.categoryId,
        editCtx,
      );
      if (!r.ok) return r;
      edited = { ...edited, ...r.split };
    }
    if (v.memberId !== undefined) {
      edited = { ...edited, ...changeMember({ ...edited, id: splitId }, v.memberId) };
    }
    if ('note' in v && v.note !== undefined) edited = { ...edited, note: v.note };

    splits = splits.map((s) => (s.id === splitId ? edited : s));
    await writeSplits(tx, ctx, t, splits);
    return { ok: true, splitId };
  });
}

// R15.3 删除非主拆分：金额全部加回主拆分。主拆分不能删除
export async function removeSplit(
  ctx: HouseholdContext,
  splitId: string,
): Promise<SplitWriteResult> {
  if (!z.uuid().safeParse(splitId).success) return INVALID;

  return db.transaction(async (tx) => {
    const transactionId = await transactionIdOfSplit(tx, ctx, splitId);
    if (!transactionId) return NOT_FOUND;
    const t = await lockTransaction(tx, ctx, transactionId);
    if (!t) return NOT_FOUND;

    const r = planRemoveSplit(t, splitId);
    if (!r.ok) return r;
    await writeSplits(tx, ctx, t, r.splits);
    return { ok: true, splitId };
  });
}
