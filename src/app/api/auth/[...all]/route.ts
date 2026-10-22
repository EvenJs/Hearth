// Better Auth 的所有接口（登录、退出、session 等）都走这里
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

export const { GET, POST } = toNextJsHandler(auth);
