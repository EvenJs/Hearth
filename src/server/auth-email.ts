// R26.7 重发验证邮件、R26.8 忘记密码、R26.5 注册后发验证邮件（M12-4）
// 登录前调用，不拿 HouseholdContext。提示不区分邮箱存不存在、是不是已经验证
// 60 秒一次：发送时间记在 Better Auth 的 verification 表（M12-4 定，不改表），
// identifier = throttle:<用途>:<邮箱>，expires_at = 发送时间 + 60 秒。按输入的邮箱记，邮箱不存在也记，提示才不会暴露邮箱注册过没有
// 只挡我们自己的入口（M12-5 的页面调这里），直接调 /api/auth/* 不经过这里，靠 Better Auth 自带的限流
// 两个请求同时进来可能都发，家里两个人用，不加锁
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, like, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { verification } from '@/db/schema';
import { auth } from '@/lib/auth';

// 点验证链接：成功自动登录、进看板。过期时 Better Auth 跳 /?error=TOKEN_EXPIRED，没登录被 proxy 带到 /login
export const VERIFY_CALLBACK_URL = '/';
// 重置链接先到 Better Auth 查 token，再跳这一页（M12-5 做）带上 ?token=
export const RESET_PASSWORD_PAGE = '/reset-password';

const THROTTLE_MS = 60_000;
type EmailKind = 'verify-email' | 'reset-password';

export type EmailRequestResult = { ok: true; message: string } | { ok: false; message: string };

const VERIFY_SENT = '如果这个邮箱注册了还没验证，验证邮件已经发出去了';
const RESET_SENT = '如果这个邮箱注册过，重置链接已经发出去了';

// 和注册时一样整理（R26.4）
const emailSchema = z.string().trim().toLowerCase().pipe(z.email('邮箱格式不对'));

const throttleKey = (kind: EmailKind, email: string) => `throttle:${kind}:${email}`;

// 还要等几秒，向上取整；0 = 能发
async function secondsToWait(kind: EmailKind, email: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ expiresAt: verification.expiresAt })
    .from(verification)
    .where(
      and(eq(verification.identifier, throttleKey(kind, email)), gt(verification.expiresAt, now)),
    )
    .orderBy(desc(verification.expiresAt))
    .limit(1);
  return row ? Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000) : 0;
}

async function recordSent(kind: EmailKind, email: string, now: Date): Promise<void> {
  // 顺手清掉过期的限流记录，不让 verification 表越积越多
  await db
    .delete(verification)
    .where(and(like(verification.identifier, 'throttle:%'), lte(verification.expiresAt, now)));
  await db.insert(verification).values({
    id: randomUUID(),
    identifier: throttleKey(kind, email),
    value: '',
    expiresAt: new Date(now.getTime() + THROTTLE_MS),
  });
}

async function throttled(
  kind: EmailKind,
  rawEmail: string,
  send: (email: string) => Promise<unknown>,
  sentMessage: string,
): Promise<EmailRequestResult> {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) return { ok: false, message: '邮箱格式不对' };
  const email = parsed.data;

  const now = new Date();
  const wait = await secondsToWait(kind, email, now);
  if (wait > 0) return { ok: false, message: `刚发过，${wait} 秒后再试` };
  await recordSent(kind, email, now);

  // 邮箱不存在、已经验证时 Better Auth 不发也不报错。发不出去也给同一句，只记日志（错误里没有链接）
  try {
    await send(email);
  } catch (error) {
    console.error(`${kind} 邮件没发出去`, error);
  }
  return { ok: true, message: sentMessage };
}

// R26.7
export function resendVerificationEmail(rawEmail: string): Promise<EmailRequestResult> {
  return throttled(
    'verify-email',
    rawEmail,
    (email) =>
      auth.api.sendVerificationEmail({ body: { email, callbackURL: VERIFY_CALLBACK_URL } }),
    VERIFY_SENT,
  );
}

// R26.8
export function requestPasswordResetEmail(rawEmail: string): Promise<EmailRequestResult> {
  return throttled(
    'reset-password',
    rawEmail,
    (email) => auth.api.requestPasswordReset({ body: { email, redirectTo: RESET_PASSWORD_PAGE } }),
    RESET_SENT,
  );
}

// R26.5 注册提交以后发。新账号总要发一封，不看限流，但记下时间，60 秒内点重发要等
// 返回发没发出去，不抛错（账号已经建好，不回滚）
export async function sendVerificationAfterSignup(email: string): Promise<boolean> {
  try {
    await recordSent('verify-email', email, new Date());
    await auth.api.sendVerificationEmail({ body: { email, callbackURL: VERIFY_CALLBACK_URL } });
    return true;
  } catch (error) {
    console.error('注册后验证邮件没发出去', error);
    return false;
  }
}
