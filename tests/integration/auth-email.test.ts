// M12-4 邮箱验证、登录、重发验证邮件、忘记密码（docs/rules/R26-invite.md R26.7、R26.8）
// 期望值来自 fixtures/cases/17-invite.md 场景 E、F-1、F-2，现在 = 2026-12-10T10:00:00+11:00
// 只用到用户，不建家庭。sendEmail 换成假的，记下发给谁和正文里的链接
// 提示文字（"邮箱还没验证…""链接过期了…"）在页面上（M12-5），这里看 Better Auth 返回的错误码
import { eq, like } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { auth } from '@/lib/auth';
import { requestPasswordResetEmail, resendVerificationEmail } from '@/server/auth-email';
import { describeDb, resetBusinessTables } from './helpers/db';

const mail = vi.hoisted(() => ({ sent: [] as { to: string; html: string }[] }));
vi.mock('@/server/email', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/email')>();
  return {
    ...real,
    sendEmail: async (to: string, _subject: string, html: string) => {
      mail.sent.push({ to, html });
      return { ok: true } as const;
    },
  };
});

const mel = (s: string) => new Date(`${s}+11:00`);
const NOW = mel('2026-12-10T10:00:00');
const at = (ms: number) => vi.setSystemTime(new Date(NOW.getTime() + ms));
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const PASSWORD = 'test-pass-1234';
const NEW_PASSWORD = 'new-pass-5678';
// kid 是 D-1 注册完、还没验证的人
const KID = { id: 'u-kid', email: 'kid@example.com', name: '小明', emailVerified: false };
const FEMALE = { id: 'u-female', email: 'female@example.com', name: '老婆', emailVerified: true };

const VERIFY_SENT = '如果这个邮箱注册了还没验证，验证邮件已经发出去了';
const RESET_SENT = '如果这个邮箱注册过，重置链接已经发出去了';

async function seedUsers(): Promise<void> {
  // 别的测试文件（invites.test.ts）留下的 household_user 还指着 @example.com 用户，先清业务表
  await resetBusinessTables();
  await db.delete(schema.user).where(like(schema.user.email, '%@example.com'));
  await db.delete(schema.verification);
  const hash = await (await auth.$context).password.hash(PASSWORD);
  for (const u of [KID, FEMALE]) {
    await db.insert(schema.user).values(u);
    await db.insert(schema.account).values({
      id: `acc-${u.id}`,
      userId: u.id,
      providerId: 'credential',
      accountId: u.id,
      password: hash,
    });
  }
}

// 正文里唯一的链接（href 里 & 转义成了 &amp;）
function linkIn(html: string): URL {
  const href = /href="([^"]+)"/.exec(html)?.[1];
  if (!href) throw new Error('邮件里没有链接');
  return new URL(href.replaceAll('&amp;', '&'));
}

const signIn = (email: string, password: string) =>
  auth.api.signInEmail({ body: { email, password } });

const isVerified = async (id: string) => {
  const [u] = await db.select().from(schema.user).where(eq(schema.user.id, id));
  return u.emailVerified;
};

const countSessions = (userId: string) =>
  db.$count(schema.session, eq(schema.session.userId, userId));

describeDb('邮箱验证和忘记密码（R26.7、R26.8）', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mail.sent = [];
    await seedUsers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------- 场景 E-1 ----------

  it('R26.7: unverified user with the right password cannot sign in and gets no email', async () => {
    await expect(signIn(KID.email, PASSWORD)).rejects.toMatchObject({
      body: { code: 'EMAIL_NOT_VERIFIED' },
    });
    expect(mail.sent).toEqual([]);
  });

  it('R26.7: unverified user with a wrong password gets the usual error', async () => {
    await expect(signIn(KID.email, 'wrong-pass-0000')).rejects.toMatchObject({
      body: { code: 'INVALID_EMAIL_OR_PASSWORD' },
    });
  });

  it('R26.7: verified user signs in', async () => {
    const res = await signIn(FEMALE.email, PASSWORD);
    expect(res.user.email).toBe(FEMALE.email);
  });

  // ---------- 场景 E-2 ----------

  it('R26.7: verification link clicked after 23 hours verifies and signs in', async () => {
    await resendVerificationEmail(KID.email);
    const link = linkIn(mail.sent[0].html);
    expect(link.pathname).toBe('/api/auth/verify-email');
    expect(link.searchParams.get('callbackURL')).toBe('/');

    at(23 * HOUR);
    await auth.api.verifyEmail({ query: { token: link.searchParams.get('token')! } });
    expect(await isVerified(KID.id)).toBe(true);
    expect(await countSessions(KID.id)).toBe(1);
  });

  it('R26.7: verification link clicked after 25 hours is expired', async () => {
    await resendVerificationEmail(KID.email);
    const token = linkIn(mail.sent[0].html).searchParams.get('token')!;

    at(25 * HOUR);
    await expect(auth.api.verifyEmail({ query: { token } })).rejects.toMatchObject({
      body: { code: 'TOKEN_EXPIRED' },
    });
    expect(await isVerified(KID.id)).toBe(false);
  });

  // ---------- 场景 E-3 ----------

  it('R26.7: resend is limited to once per 60 seconds per email, rounding up', async () => {
    expect(await resendVerificationEmail(KID.email)).toEqual({ ok: true, message: VERIFY_SENT });
    expect(mail.sent).toHaveLength(1);

    at(30 * SECOND);
    expect(await resendVerificationEmail(KID.email)).toEqual({
      ok: false,
      message: '刚发过，30 秒后再试',
    });
    at(59.5 * SECOND);
    expect(await resendVerificationEmail(' Kid@Example.com ')).toEqual({
      ok: false,
      message: '刚发过，1 秒后再试',
    });
    expect(mail.sent).toHaveLength(1);

    at(60 * SECOND);
    expect(await resendVerificationEmail(KID.email)).toEqual({ ok: true, message: VERIFY_SENT });
    expect(mail.sent.map((m) => m.to)).toEqual([KID.email, KID.email]);
  });

  it('R26.7: unknown or already verified email gets the same message and no email', async () => {
    expect(await resendVerificationEmail('nobody@example.com')).toEqual({
      ok: true,
      message: VERIFY_SENT,
    });
    expect(await resendVerificationEmail(FEMALE.email)).toEqual({ ok: true, message: VERIFY_SENT });
    expect(mail.sent).toEqual([]);
  });

  // ---------- 场景 F-1 ----------

  it('R26.8: forgot password sends a reset link, unknown email gets the same message', async () => {
    expect(await requestPasswordResetEmail(FEMALE.email)).toEqual({
      ok: true,
      message: RESET_SENT,
    });
    expect(await requestPasswordResetEmail('nobody@example.com')).toEqual({
      ok: true,
      message: RESET_SENT,
    });
    expect(mail.sent.map((m) => m.to)).toEqual([FEMALE.email]);
    const link = linkIn(mail.sent[0].html);
    expect(link.pathname).toMatch(/^\/api\/auth\/reset-password\/[^/]+$/);
    expect(link.searchParams.get('callbackURL')).toBe('/reset-password');
  });

  it('R26.8: forgot password again within 60 seconds is refused', async () => {
    await requestPasswordResetEmail(FEMALE.email);
    at(30 * SECOND);
    expect(await requestPasswordResetEmail(FEMALE.email)).toEqual({
      ok: false,
      message: '刚发过，30 秒后再试',
    });
    expect(mail.sent).toHaveLength(1);
  });

  // ---------- 场景 F-2 ----------

  async function resetToken(): Promise<string> {
    await requestPasswordResetEmail(FEMALE.email);
    return linkIn(mail.sent[0].html).pathname.split('/').pop()!;
  }

  it('R26.8: reset after 59 minutes changes the password and signs out every session', async () => {
    await signIn(FEMALE.email, PASSWORD); // 设备 A
    await signIn(FEMALE.email, PASSWORD); // 设备 B
    expect(await countSessions(FEMALE.id)).toBe(2);
    const token = await resetToken();

    at(59 * MINUTE);
    await auth.api.resetPassword({ body: { token, newPassword: NEW_PASSWORD } });
    expect(await countSessions(FEMALE.id)).toBe(0);
    await expect(signIn(FEMALE.email, PASSWORD)).rejects.toMatchObject({
      body: { code: 'INVALID_EMAIL_OR_PASSWORD' },
    });
    expect((await signIn(FEMALE.email, NEW_PASSWORD)).user.email).toBe(FEMALE.email);
  });

  it('R26.8: reset link after 61 minutes is expired and the password stays', async () => {
    const token = await resetToken();
    at(61 * MINUTE);
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: NEW_PASSWORD } }),
    ).rejects.toMatchObject({ body: { code: 'INVALID_TOKEN' } });
    expect((await signIn(FEMALE.email, PASSWORD)).user.email).toBe(FEMALE.email);
  });

  it('R26.8: reset link works only once', async () => {
    const token = await resetToken();
    await auth.api.resetPassword({ body: { token, newPassword: NEW_PASSWORD } });
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: 'another-pass-9999' } }),
    ).rejects.toMatchObject({ body: { code: 'INVALID_TOKEN' } });
    expect((await signIn(FEMALE.email, NEW_PASSWORD)).user.email).toBe(FEMALE.email);
  });

  it('R26.8: new password of 7 characters is refused', async () => {
    const token = await resetToken();
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: 'short-7' } }),
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_TOO_SHORT' } });
    expect((await signIn(FEMALE.email, PASSWORD)).user.email).toBe(FEMALE.email);
  });

  it('R26.8: unverified user can reset but still cannot sign in before verifying', async () => {
    await requestPasswordResetEmail(KID.email);
    const token = linkIn(mail.sent[0].html).pathname.split('/').pop()!;
    await auth.api.resetPassword({ body: { token, newPassword: NEW_PASSWORD } });
    await expect(signIn(KID.email, NEW_PASSWORD)).rejects.toMatchObject({
      body: { code: 'EMAIL_NOT_VERIFIED' },
    });
  });
});
