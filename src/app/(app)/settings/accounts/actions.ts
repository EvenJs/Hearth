'use server';

// 账户的 Server Actions。输入在这里用 Zod 再校验一次（前端校验可以被绕过）
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { accountInputSchema, type AccountInput } from '@/lib/accounts/account-input';
import { cardInputSchema, type CardInput } from '@/lib/accounts/card-input';
import { AccountError, createAccount, setAccountArchived, updateAccount } from '@/server/accounts';
import { CardError, createCard, deleteCard } from '@/server/cards';
import { getHouseholdContext } from '@/server/context';

export type ActionResult<Field extends string = keyof AccountInput> =
  | { ok: true }
  | {
      ok: false;
      message: string;
      fieldErrors?: Partial<Record<Field, string>>;
    };

const idSchema = z.uuid(); // 账户和卡的 id 都是 uuid
const PAGE = '/settings/accounts';

// accountId 为 null 时新建，否则编辑
export async function saveAccountAction(
  accountId: string | null,
  input: AccountInput,
): Promise<ActionResult> {
  const ctx = await getHouseholdContext();

  const parsed = accountInputSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<keyof AccountInput, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof AccountInput;
      fieldErrors[field] ??= issue.message;
    }
    return { ok: false, message: '请检查表单', fieldErrors };
  }

  try {
    if (accountId === null) {
      await createAccount(ctx, parsed.data);
    } else {
      await updateAccount(ctx, idSchema.parse(accountId), parsed.data);
    }
  } catch (err) {
    return toFailure(err);
  }

  revalidatePath(PAGE);
  return { ok: true };
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

function toFailure<Field extends string>(err: unknown): ActionResult<Field> {
  if (err instanceof AccountError || err instanceof CardError) {
    const fieldErrors = err.field
      ? ({ [err.field]: err.message } as Partial<Record<Field, string>>)
      : undefined;
    return { ok: false, message: err.message, fieldErrors };
  }
  console.error('[accounts] 保存失败', err);
  return { ok: false, message: '保存失败，请稍后再试' };
}
