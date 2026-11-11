'use server';

// 登录页"重发验证邮件"（R26.7，M12-5）。登录前调用，不拿 HouseholdContext
// 邮箱整理、60 秒限流、统一提示都在 src/server/auth-email.ts
import { z } from 'zod';
import { resendVerificationEmail, type EmailRequestResult } from '@/server/auth-email';

const emailSchema = z.string().max(320);

export async function resendVerificationAction(email: string): Promise<EmailRequestResult> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, message: '邮箱格式不对' };
  return resendVerificationEmail(parsed.data);
}
