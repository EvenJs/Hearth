import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { listAccounts } from '@/server/accounts';
import { listCards } from '@/server/cards';
import { getHouseholdContext } from '@/server/context';
import { listMembers } from '@/server/members';
import { AccountsView } from './accounts-view';

// F1 账户设置（设计图 09）：账户列表 + 编辑侧栏里的卡号映射（M1-6）
export default function AccountsPage(props: PageProps<'/settings/accounts'>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-col gap-1">
        <Link
          href="/"
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          首页
        </Link>
        <h1 className="text-2xl font-semibold">账户</h1>
        <p className="text-sm text-muted-foreground">
          只保存账号尾号，用来识别内部转账；不保存完整账号和 BSB。
        </p>
      </header>

      {/* 读 session 和 searchParams 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <AccountsSection searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}

async function AccountsSection({
  searchParams,
}: {
  searchParams: PageProps<'/settings/accounts'>['searchParams'];
}) {
  const showArchived = (await searchParams).archived === '1';
  const ctx = await getHouseholdContext();
  const [accounts, cards, members] = await Promise.all([
    listAccounts(ctx, { includeArchived: showArchived }),
    listCards(ctx),
    listMembers(ctx),
  ]);
  return (
    <AccountsView accounts={accounts} cards={cards} members={members} showArchived={showArchived} />
  );
}
