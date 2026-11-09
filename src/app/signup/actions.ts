'use server';

// 注册的 Server Action（M12-5，R26.4、R26.5）。登录前调用，不拿 HouseholdContext
// 这里只校验形状，字段整理、校验顺序、提示、事务都在 registerWithInvite（src/server/invites.ts）
import { z } from 'zod';
import { registerWithInvite, type RegisterResult } from '@/server/invites';

const signupSchema = z.object({
  email: z.string().max(320),
  name: z.string().max(200),
  password: z.string().max(1000),
  code: z.string().max(100),
});

export type SignupActionInput = z.infer<typeof signupSchema>;

export async function signupAction(input: SignupActionInput): Promise<RegisterResult> {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) return { ok: false, field: 'form', message: '请检查输入' };
  try {
    return await registerWithInvite(parsed.data);
  } catch (error) {
    // 不打输入（码、密码）
    console.error('signupAction 失败', error);
    return { ok: false, field: 'form', message: '注册没成功，再试一次' };
  }
}
