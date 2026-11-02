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
  // manifest 和图标没登录也要能拿到，否则"添加到主屏幕"拿不到图标（M7.8-1）。只放行这几个，不放宽到所有带扩展名的文件
  matcher: [
    '/((?!login|api/auth|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.png|apple-icon.png|icons/).*)',
  ],
};
