// 服务端 session 检查（数据访问层的一部分）
// 页面和 Server Action 都通过 getCurrentUser() 拿当前用户，不依赖 proxy 的 cookie 检查
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/lib/auth';

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
};

// 没登录或 session 失效时直接跳 /login。同一次请求里多次调用只查一次（React cache）
export const getCurrentUser = cache(async (): Promise<CurrentUser> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect('/login');
  }
  const { id, name, email } = session.user;
  return { id, name, email };
});
