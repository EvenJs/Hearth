// pnpm user:create --email you@example.com --name Johnson --password '...'
// 在服务器端直接建用户和密码账号，不走注册接口（注册已关闭）。
// 用 auth.$context 的 internalAdapter，和 admin 插件 createUser 内部做法一样，但不加表字段。
// 注意：$context 是半内部 API，升级 better-auth 后要重新跑一次验证。
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { pool } from '../src/db/index.ts';
import { auth } from '../src/lib/auth.ts';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
  },
});

const input = z
  .object({
    email: z.email('email 格式不对').transform((v) => v.toLowerCase()),
    name: z.string().trim().min(1, 'name 不能为空'),
    password: z.string(),
  })
  .safeParse(values);

if (!input.success) {
  console.error('参数错误:', z.prettifyError(input.error));
  console.error("用法: pnpm user:create --email a@b.com --name 名字 --password '密码'");
  process.exit(1);
}

const { email, name, password } = input.data;

try {
  const ctx = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (password.length < minPasswordLength || password.length > maxPasswordLength) {
    throw new Error(`密码长度要在 ${minPasswordLength} 到 ${maxPasswordLength} 之间`);
  }
  if (await ctx.internalAdapter.findUserByEmail(email)) {
    throw new Error(`用户已存在: ${email}`);
  }

  const hash = await ctx.password.hash(password);
  const user = await ctx.internalAdapter.createUser(
    { email, name, emailVerified: true },
    { method: 'admin' },
  );
  try {
    // credential 账号的 accountId 就是 user.id，和 Better Auth 注册流程一致
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: hash,
    });
  } catch (error) {
    // 没有密码账号的用户登录不了，回滚掉
    await ctx.internalAdapter.deleteUser(user.id);
    throw error;
  }

  console.log('用户已创建:', { id: user.id, email: user.email, name: user.name });
} catch (error) {
  console.error('创建用户失败:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
