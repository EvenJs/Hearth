'use server';

// 账户的 Server Actions。输入在这里用 Zod 再校验一次（前端校验可以被绕过）
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  accountInputSchema,
  type AccountInput,
  type AccountValues,
} from '@/lib/accounts/account-input';
import { cardInputSchema, type CardInput } from '@/lib/accounts/card-input';
import {
  AccountError,
  createAccount,
  previewTransferRedetect,
  setAccountArchived,
  updateAccount,
} from '@/server/accounts';
import { CardError, createCard, deleteCard } from '@/server/cards';
import { getHouseholdContext } from '@/server/context';

export type ActionResult<Field extends string = keyof AccountInput> =
  | { ok: true }
  | {
      ok: false;
      message: string;
      fieldErrors?: Partial<Record<Field, string>>;
    };

type ActionFailure<Field extends string = keyof AccountInput> = Extract<
  ActionResult<Field>,
  { ok: false }
>;

const idSchema = z.uuid(); // 账户和卡的 id 都是 uuid
const PAGE = '/settings/accounts';

function parseAccountInput(
  input: AccountInput,
): { ok: true; values: AccountValues } | { ok: false; failure: ActionFailure } {
  const parsed = accountInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, values: parsed.data };
  const fieldErrors: Partial<Record<keyof AccountInput, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as keyof AccountInput;
    fieldErrors[field] ??= issue.message;
  }
  return { ok: false, failure: { ok: false, message: '请检查表单', fieldErrors } };
}

export type PreviewAccountSaveResult =
  { ok: true; count: number; keptCount: number } | ActionFailure;

// R6.4 保存前预览：保存后有几笔旧交易会认成内部转账（N）、几笔对上了但不改（M）
// 校验失败时和保存一样返回字段错误，表单直接显示
export async function previewAccountSaveAction(
  accountId: string | null,
  input: AccountInput,
): Promise<PreviewAccountSaveResult> {
  const ctx = await getHouseholdContext();
  const parsed = parseAccountInput(input);
  if (!parsed.ok) return parsed.failure;
  try {
    const id = accountId === null ? null : idSchema.parse(accountId);
    const p = await previewTransferRedetect(ctx, id, parsed.values);
    return { ok: true, ...p };
  } catch (err) {
    return toFailure(err);
  }
}

export type SaveAccountResult =
  { ok: true; redetectedCount: number; pairedCount: number } | ActionFailure;

// accountId 为 null 时新建，否则编辑
// redetect：R6.4 弹窗里选了"改"，同一个事务里把旧交易认成内部转账并跑 R6.2
export async function saveAccountAction(
  accountId: string | null,
  input: AccountInput,
  redetect = false,
): Promise<SaveAccountResult> {
  const ctx = await getHouseholdContext();
  const parsed = parseAccountInput(input);
  if (!parsed.ok) return parsed.failure;

  const options = { redetect: z.boolean().parse(redetect) };
  let result;
  try {
    result =
      accountId === null
        ? await createAccount(ctx, parsed.values, options)
        : await updateAccount(ctx, idSchema.parse(accountId), parsed.values, options);
  } catch (err) {
    return toFailure(err);
  }

  revalidatePath(PAGE);
  if (result.redetectedCount > 0) {
    // 交易的分类和转账状态变了，流水和看板也要刷新
    revalidatePath('/transactions', 'layout');
    revalidatePath('/');
  }
  return { ok: true, ...result };
}

export async function setAccountArchivedAction(
  accountId: string,
  archived: boolean,
): Promise<ActionResult> {
  const ctx = await getHouseholdContext();
  try {
    await setAccountArchived(ctx, idSchema.parse(accountId), z.boolean().parse(archived));
  } catch (err) {
    return toFailure(err);
  }
  revalidatePath(PAGE);
  return { ok: true };
}

// ---------- 卡号映射（M1-6） ----------

export async function createCardAction(
  accountId: string,
  input: CardInput,
): Promise<ActionResult<keyof CardInput>> {
  const ctx = await getHouseholdContext();

  const parsed = cardInputSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<keyof CardInput, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof CardInput;
      fieldErrors[field] ??= issue.message;
    }
    return { ok: false, message: '请检查表单', fieldErrors };
  }

  try {
    await createCard(ctx, idSchema.parse(accountId), parsed.data);
  } catch (err) {
    return toFailure(err);
  }
  revalidatePath(PAGE);
  return { ok: true };
}

export async function deleteCardAction(cardId: string): Promise<ActionResult<never>> {
  const ctx = await getHouseholdContext();
  try {
    await deleteCard(ctx, idSchema.parse(cardId));
  } catch (err) {
    return toFailure(err);
  }
  revalidatePath(PAGE);
  return { ok: true };
}

function toFailure<Field extends string>(err: unknown): ActionFailure<Field> {
  if (err instanceof AccountError || err instanceof CardError) {
    const fieldErrors = err.field
      ? ({ [err.field]: err.message } as Partial<Record<Field, string>>)
      : undefined;
    return { ok: false, message: err.message, fieldErrors };
  }
  console.error('[accounts] 保存失败', err);
  return { ok: false, message: '保存失败，请稍后再试' };
}
