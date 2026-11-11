// 路由拦截（Next.js 16 起 middleware 改名为 proxy）
// 这里只做乐观检查：看有没有 Better Auth 的 session cookie，不查数据库（Next.js 文档的建议）。
// cookie 存在不代表 session 有效，真正的校验在服务端 getCurrentUser()（src/server/auth.ts）
import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    const login = new URL('/login', request.url);
    // R26.7 验证链接过期时 Better Auth 跳 /?error=TOKEN_EXPIRED，没登录会被带到这里。只带 error，登录页据此提示
    const error = request.nextUrl.searchParams.get('error');
    if (error) login.searchParams.set('error', error);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  // 除了登录前的页面（登录、注册、忘记密码、重置密码，M12-5）、/api/auth/* 和静态资源，其他路径都要登录
  // manifest 和图标没登录也要能拿到，否则"添加到主屏幕"拿不到图标（M7.8-1）。只放行这几个，不放宽到所有带扩展名的文件
  matcher: [
    '/((?!login|signup|forgot-password|reset-password|api/auth|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.png|apple-icon.png|icons/).*)',
  ],
};
