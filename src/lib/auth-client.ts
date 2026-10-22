// 浏览器端的 Better Auth 客户端：登录、退出都走 /api/auth/*（带 Better Auth 自带的限流）
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();
