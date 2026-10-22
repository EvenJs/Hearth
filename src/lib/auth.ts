// Better Auth 配置：只开邮箱密码登录，关闭公开注册（tech-stack 第 4 节）
// 账号用 `pnpm user:create` 在服务器端创建，见 scripts/create-user.ts
// BETTER_AUTH_SECRET、BETTER_AUTH_URL 由 Better Auth 自动从环境变量读取
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../db/index.ts';
import * as schema from '../db/schema.ts';

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: {
    enabled: true,
    // 关闭注册：注册接口直接返回错误，服务端调用 signUpEmail 也会被拦
    disableSignUp: true,
  },
});
