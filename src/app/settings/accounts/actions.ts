'use server';

// 账户的 Server Actions。输入在这里用 Zod 再校验一次（前端校验可以被绕过）
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { accountInputSchema, type AccountInput } from '@/lib/accounts/account-input';
import { AccountError, createAccount, setAccountArchived, updateAccount } from '@/server/accounts';
import { getHouseholdContext } from '@/server/context';

export type ActionResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      fieldErrors?: Partial<Record<keyof AccountInput, string>>;
    };

const accountIdSchema = z.uuid();
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
      await updateAccount(ctx, accountIdSchema.parse(accountId), parsed.data);
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
    await setAccountArchived(ctx, accountIdSchema.parse(accountId), z.boolean().parse(archived));
  } catch (err) {
    return toFailure(err);
  }
  revalidatePath(PAGE);
  return { ok: true };
}

function toFailure(err: unknown): ActionResult {
  if (err instanceof AccountError) {
    return err.field
      ? { ok: false, message: err.message, fieldErrors: { [err.field]: err.message } }
      : { ok: false, message: err.message };
  }
  console.error('[accounts] 保存失败', err);
  return { ok: false, message: '保存失败，请稍后再试' };
}
