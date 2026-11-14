import { Suspense } from 'react';
import { TableSkeleton } from '@/components/skeletons';
import { getCurrentUser } from '@/server/auth';
import { ProfileView } from './profile-view';

// 设置 → 账号（design/README 21，M12-9，R26.8）
// 不出设计图：照现有设置页做，两张卡片。路由叫 profile，免得和 /settings/accounts 混
export default function ProfilePage() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">设置 / 账号</p>
        <h1 className="text-2xl font-semibold">我的账号</h1>
        <p className="text-sm text-muted-foreground">改名字和密码。邮箱不能改。</p>
      </header>

      {/* 读 session 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<TableSkeleton rows={4} />}>
        <ProfileSection />
      </Suspense>
    </>
  );
}

async function ProfileSection() {
  const user = await getCurrentUser();
  return <ProfileView email={user.email} name={user.name} />;
}
