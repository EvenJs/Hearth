// 数据访问层的入口：每个请求先拿 HouseholdContext，再传给 src/server/ 下的查询函数
// 约定：src/server/ 下每个查询函数第一个参数都是 ctx，内部都带 household_id 条件
// 页面和组件不直接 import @/db，只调用这里和其他 src/server/ 模块
import { eq } from 'drizzle-orm';
import { cache } from 'react';
import { db } from '@/db';
import { householdUser } from '@/db/schema';
import { getCurrentUser } from './auth';

export type HouseholdContext = {
  userId: string;
  householdId: string;
  // household_user.member_id 可以为空（schema 允许），用到时自己判断
  memberId: string | null;
};

export class NoHouseholdError extends Error {
  constructor(userId: string) {
    super(`用户 ${userId} 没有加入任何 household，先跑 pnpm db:seed --email <你的邮箱>`);
    this.name = 'NoHouseholdError';
  }
}

// 没登录：getCurrentUser() 会 redirect('/login')（Next.js 用抛错实现跳转）
// 登录了但没有 household：抛 NoHouseholdError
// 同一次请求里多次调用只查一次（React cache）
export const getHouseholdContext = cache(async (): Promise<HouseholdContext> => {
  const user = await getCurrentUser();

  const [link] = await db
    .select({ householdId: householdUser.householdId, memberId: householdUser.memberId })
    .from(householdUser)
    .where(eq(householdUser.userId, user.id));

  if (!link) {
    throw new NoHouseholdError(user.id);
  }

  return { userId: user.id, householdId: link.householdId, memberId: link.memberId };
});
