import { Suspense } from 'react';
import { getHouseholdContext } from '@/server/context';
import { canIssueNewHousehold, listInvites } from '@/server/invites';
import { listMembers } from '@/server/members';
import { InvitesView } from './invites-view';

// 设置 → 邀请（design/README 20，M12-6，R26.2、R26.3）
// 不出设计图：照规则设置页的表格和 Dialog 做
export default function InvitesPage() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">设置 / 邀请</p>
        <h1 className="text-2xl font-semibold">邀请</h1>
        <p className="text-sm text-muted-foreground">
          发邀请码给要注册的人。码 3 天内有效，只能用一次。
        </p>
      </header>

      {/* 读 session 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <InvitesSection />
      </Suspense>
    </>
  );
}

async function InvitesSection() {
  const ctx = await getHouseholdContext();
  const [invites, members, isAdmin] = await Promise.all([
    listInvites(ctx),
    listMembers(ctx), // R26.2 join 只能选没归档的
    canIssueNewHousehold(ctx),
  ]);
  return <InvitesView invites={invites} members={members} canIssueNewHousehold={isAdmin} />;
}
