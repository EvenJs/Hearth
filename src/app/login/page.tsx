import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { LoginForm, type LoginNotice } from './login-form';

export const metadata: Metadata = {
  title: '登录 · Hearth',
};

// 设计图 01-login。M12 起有邀请码才能注册（R26），这里放注册、忘记密码入口
export default function LoginPage(props: PageProps<'/login'>) {
  return (
    <AuthShell title="登录">
      {/* 读 searchParams 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<LoginForm notice={null} />}>
        <LoginSection searchParams={props.searchParams} />
      </Suspense>
      <p className="text-center text-sm text-muted-foreground">
        有邀请码？
        <Link href="/signup" className="text-foreground underline-offset-4 hover:underline">
          去注册
        </Link>
      </p>
    </AuthShell>
  );
}

async function LoginSection({
  searchParams,
}: {
  searchParams: PageProps<'/login'>['searchParams'];
}) {
  const params = await searchParams;
  // R26.8 重置成功跳回来带 ?reset=1；R26.7 验证链接过期，Better Auth 带 ?error=（proxy 转过来）
  const notice: LoginNotice =
    params.reset === '1'
      ? { kind: 'info', message: '密码改好了，请登录' }
      : params.error
        ? { kind: 'error', message: '链接过期了，回登录页重发验证邮件' }
        : null;
  return <LoginForm notice={notice} />;
}
