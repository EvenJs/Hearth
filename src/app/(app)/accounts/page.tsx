import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { groupByPurpose } from '@/lib/rules/balance';
import { todayInMelbourne } from '@/lib/rules/periods';
import { getAccountBalances } from '@/server/balances';
import { getConditionProgress } from '@/server/conditions';
import { getHouseholdContext } from '@/server/context';
import { AccountsOverview } from './accounts-overview';

// F12 账户总览（设计图 15 不出图，照看板卡片做，M9-5）：按用途分组的余额、合计、本财年利息（R23.5、R23.6）
// 每个账户可以手动校准（R23.3，M9-6）。有条件的账户加本月进度和历史（R24.10，M10-6）
// 不跟看板的时间段和归属人筛选
export default function AccountsPage() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">账户</h1>
        <p className="text-sm text-muted-foreground">
          余额 = 对账单期末或手动填的数，加上之后的交易。
        </p>
      </header>

      {/* 读 session 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <AccountsSection />
      </Suspense>
    </>
  );
}

async function AccountsSection() {
  const ctx = await getHouseholdContext();
  // "今天"每次请求都要重新算（本财年利息、校准日期默认昨天），不能被预渲染
  await connection();
  const today = todayInMelbourne();
  const [accounts, progress] = await Promise.all([
    getAccountBalances(ctx, today),
    getConditionProgress(ctx, today),
  ]);

  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        还没有账户，先去{' '}
        <Link href="/settings/accounts" className="text-primary underline-offset-4 hover:underline">
          设置 / 账户
        </Link>{' '}
        添加。
      </p>
    );
  }
  const conditions = new Map(progress.accounts.map((p) => [p.accountId, p]));
  return (
    <AccountsOverview overview={groupByPurpose(accounts)} conditions={conditions} today={today} />
  );
}
