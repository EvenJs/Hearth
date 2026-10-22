import { Suspense } from 'react';
import { HearthLogo } from '@/components/hearth-logo';
import { getCurrentUser } from '@/server/auth';
import { SignOutButton } from './sign-out-button';

// M0 空壳首页：只确认登录状态。看板在 M5 做（设计图 02）
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <HearthLogo className="size-7 text-primary" />
          <h1 className="text-xl font-semibold">Hearth</h1>
        </div>
        {/* 读 session 的部分必须放在 Suspense 里（cacheComponents） */}
        <Suspense fallback={<div className="h-8" />}>
          <CurrentUserBar />
        </Suspense>
      </header>
    </main>
  );
}

async function CurrentUserBar() {
  const user = await getCurrentUser();
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">{user.name}</span>
      <SignOutButton />
    </div>
  );
}
