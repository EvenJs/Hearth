import { connection } from 'next/server';
import { Suspense } from 'react';
import { todayInMelbourne } from '@/lib/rules/periods';
import { listAccounts } from '@/server/accounts';
import { getHouseholdContext } from '@/server/context';
import { getGoals } from '@/server/goals';
import { GoalsView } from './goals-view';

// F14 目标和应急金（设计图 16 不出图，照 /accounts 和看板卡片做，M11-5，R25.11）
// 进度、每月要存、预计达成、能撑几个月都在 getGoals 里实时算
// 不跟看板的时间段和归属人筛选
export default function GoalsPage() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">目标</h1>
        <p className="text-sm text-muted-foreground">
          挂了账户的目标按顺序用账户余额填进度：先填满第一个，剩下的给下一个。
        </p>
      </header>

      {/* 读 session 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <GoalsSection />
      </Suspense>
    </>
  );
}

async function GoalsSection() {
  const ctx = await getHouseholdContext();
  // "今天"每次请求都要重新算（每月要存、预计达成、过期），不能被预渲染
  await connection();
  const today = todayInMelbourne();
  const [overview, accounts] = await Promise.all([getGoals(ctx, today), listAccounts(ctx)]);

  // R25.1：下拉里去掉已归档的（listAccounts 默认不含）和现金账户
  const options = accounts
    .filter((a) => a.bank !== 'cash')
    .map((a) => ({ id: a.id, name: a.name }));
  return <GoalsView overview={overview} accounts={options} />;
}
