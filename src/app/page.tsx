import Link from 'next/link';
import { Suspense } from 'react';
import { HearthLogo } from '@/components/hearth-logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentUser } from '@/server/auth';
import { listCategoryTree } from '@/server/categories';
import { getHouseholdContext } from '@/server/context';
import { listMembers } from '@/server/members';
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

      {/* M1-4 临时验证：数据访问层能查到归属人和分类。M5 做看板时删掉 */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <DataAccessCheck />
      </Suspense>
    </main>
  );
}

async function CurrentUserBar() {
  const user = await getCurrentUser();
  return (
    <div className="flex items-center gap-3">
      {/* 临时入口，M5 做侧边栏导航后去掉 */}
      <Button variant="ghost" size="sm" asChild>
        <Link href="/settings/accounts">账户设置</Link>
      </Button>
      <span className="text-sm text-muted-foreground">{user.name}</span>
      <SignOutButton />
    </div>
  );
}

async function DataAccessCheck() {
  const ctx = await getHouseholdContext();
  const [members, tree] = await Promise.all([listMembers(ctx), listCategoryTree(ctx)]);
  const normal = tree.filter((c) => c.kind !== 'system');
  const system = tree.filter((c) => c.kind === 'system');

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>归属人（{members.length}）</CardTitle>
          <CardDescription>临时验证用</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {members.map((m) => (
              <li key={m.id}>
                {m.name} <span className="text-muted-foreground">· {m.kind}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>一级分类（{normal.length}）</CardTitle>
          <CardDescription>括号里是二级分类数量</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {normal.map((c) => (
              <li key={c.id}>
                {c.nameEn}{' '}
                <span className="text-muted-foreground">
                  · {c.kind}（{c.children.length}）
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>系统分类（{system.length}）</CardTitle>
          <CardDescription>内部转账、取现、银行费用、未分类</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {system.map((c) => (
              <li key={c.id}>
                {c.nameEn} <span className="text-muted-foreground">· {c.systemKey}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
