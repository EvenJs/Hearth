import type { ReactNode } from 'react';
import { HearthLogo } from '@/components/hearth-logo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// 登录前页面的外壳（设计图 01）：登录、注册、忘记密码、重置密码共用（设计图 17 到 19 照 01 做）
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
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
            <CardTitle className="text-lg">{title}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6 px-6 sm:px-10">{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}
