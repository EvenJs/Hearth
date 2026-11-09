// Better Auth 配置：只开邮箱密码登录，关闭 Better Auth 自己的注册接口（tech-stack 第 4 节）
// 注册走邀请码（R26，src/server/invites.ts 的 registerWithInvite，方案 a）；`pnpm user:create` 留着当后门
// BETTER_AUTH_SECRET、BETTER_AUTH_URL 由 Better Auth 自动从环境变量读取
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../db/index.ts';
import * as schema from '../db/schema.ts';
import {
  resetPasswordEmail,
  sendEmail,
  verificationEmail,
  type EmailContent,
} from '../server/email.ts';

// 发不出去时抛错：注册后发验证邮件要知道结果（R26.5），重发、忘记密码由调用方吞掉给同一句提示
async function deliver(to: string, { subject, html }: EmailContent): Promise<void> {
  const result = await sendEmail(to, subject, html);
  if (!result.ok) throw new Error('邮件没发出去');
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: {
    enabled: true,
    // 关闭注册：注册接口直接返回错误，服务端调用 signUpEmail 也会被拦
    disableSignUp: true,
    // R26.7 没验证不能登录：密码对时返回 403 EMAIL_NOT_VERIFIED
    requireEmailVerification: true,
    // R26.8 重置链接 1 小时，只能用一次（存 verification 表）；重置后这个用户所有 session 退出
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: ({ user, url }) => deliver(user.email, resetPasswordEmail(user.name, url)),
  },
  emailVerification: {
    // R26.7 验证链接 24 小时；点了自动登录
    expiresIn: 24 * 60 * 60,
    autoSignInAfterVerification: true,
    // 登录时不自动发，登录页有"重发验证邮件"（60 秒一次，src/server/auth-email.ts）
    sendOnSignIn: false,
    sendVerificationEmail: ({ user, url }) =>
      deliver(user.email, verificationEmail(user.name, url)),
  },
});
