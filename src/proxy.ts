// 路由拦截（Next.js 16 起 middleware 改名为 proxy）
// 这里只做乐观检查：看有没有 Better Auth 的 session cookie，不查数据库（Next.js 文档的建议）。
// cookie 存在不代表 session 有效，真正的校验在服务端 getCurrentUser()（src/server/auth.ts）
import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  // 除了 /login、/api/auth/* 和静态资源，其他路径都要登录
  matcher: ['/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)'],
};
