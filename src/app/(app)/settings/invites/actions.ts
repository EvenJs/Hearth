'use server';

// 设置 → 邀请的 Server Actions（M12-6，R26.2、R26.3）。输入在这里用 Zod 再校验一次
// 谁能发、归属人对不对、能不能撤销在 src/server/invites.ts 里判断
// 邀请码不打日志
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getHouseholdContext } from '@/server/context';
import {
  createInvite,
  revokeInvite,
  type CreateInviteResult,
  type RevokeInviteResult,
} from '@/server/invites';

const createSchema = z.object({
  purpose: z.enum(['join', 'new_household']),
  memberId: z.string().max(100).nullable(),
});

export type CreateInviteActionInput = z.infer<typeof createSchema>;

const INVALID = { ok: false, message: '请检查输入' } as const;
const FAILED = { ok: false, message: '没成功，请稍后再试' } as const;

export async function createInviteAction(
  input: CreateInviteActionInput,
): Promise<CreateInviteResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await createInvite(ctx, parsed.data);
    if (r.ok) revalidatePath('/settings/invites');
    return r;
  } catch (err) {
    console.error('[invites] 发码失败', err instanceof Error ? err.name : typeof err);
    return FAILED;
  }
}

export async function revokeInviteAction(id: string): Promise<RevokeInviteResult> {
  if (typeof id !== 'string') return INVALID;
  const ctx = await getHouseholdContext();
  try {
    const r = await revokeInvite(ctx, id);
    if (r.ok) revalidatePath('/settings/invites');
    return r;
  } catch (err) {
    console.error('[invites] 撤销失败', err instanceof Error ? err.name : typeof err);
    return FAILED;
  }
}
