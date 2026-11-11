'use server';

// 忘记密码（R26.8，M12-5）。登录前调用，不拿 HouseholdContext
// 邮箱整理、60 秒限流、"如果这个邮箱注册过"统一提示都在 src/server/auth-email.ts
import { z } from 'zod';
import { requestPasswordResetEmail, type EmailRequestResult } from '@/server/auth-email';

const emailSchema = z.string().max(320);

export async function forgotPasswordAction(email: string): Promise<EmailRequestResult> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, message: '邮箱格式不对' };
  return requestPasswordResetEmail(parsed.data);
}
