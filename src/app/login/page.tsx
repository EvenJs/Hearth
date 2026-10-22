import type { Metadata } from 'next';
import { HearthLogo } from '@/components/hearth-logo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: '登录 · Hearth',
};

// 设计图 01-login。不开放注册，所以没有注册入口
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-md flex-col gap-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <HearthLogo className="size-11 text-primary" />
          <p className="mt-2 text-lg">Hearth</p>
          <p className="text-muted-foreground">家庭财务管理</p>
        </div>

        <Card className="gap-6 py-8">
          <CardHeader className="px-6 sm:px-10">
            <CardTitle className="text-lg">登录</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6 px-6 sm:px-10">
            <LoginForm />
            <p className="text-center text-sm text-muted-foreground">
              仅限家庭成员使用，不开放注册
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
