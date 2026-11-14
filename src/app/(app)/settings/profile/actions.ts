'use server';

// 设置 → 账号的 Server Actions（M12-9，R26.8）
// 只有改名字走这里；改密码在客户端调 authClient.changePassword，新 session 的 cookie 才能写回浏览器
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getCurrentUser } from '@/server/auth';
import { userNameSchema } from '@/server/invites';

export type UpdateNameResult = { ok: true } | { ok: false; message: string };

// R26.8 改名字：校验同 R26.4，只改 user.name，不改归属人
export async function updateNameAction(name: string): Promise<UpdateNameResult> {
  const parsed = userNameSchema.safeParse(typeof name === 'string' ? name : '');
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  await getCurrentUser(); // 没登录跳 /login
  try {
    await auth.api.updateUser({ body: { name: parsed.data }, headers: await headers() });
  } catch (err) {
    console.error('[profile] 改名字失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '没成功，请稍后再试' };
  }
  // 右上角的名字在 layout 里读
  revalidatePath('/', 'layout');
  return { ok: true };
}
