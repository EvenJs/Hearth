import { Suspense } from 'react';
import { Brand } from '@/components/app-shell/brand';
import { MobileNav } from '@/components/app-shell/mobile-nav';
import { SidebarNav, SidebarNavFallback } from '@/components/app-shell/sidebar-nav';
import { SignOutButton } from '@/components/app-shell/sign-out-button';
import { QuickAddButton } from '@/components/quick-add/quick-add-button';
import { getCurrentUser } from '@/server/auth';
import { getReceiptReader } from '@/server/receipt-readers';

// 登录后的页面共用：左侧边栏 + 顶栏（docs/design/README.md 第 3 节、02-dashboard.png）
// 电脑（lg 以上）侧边栏常驻；窄屏收进 Sheet（MobileNav）
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 border-r bg-background px-3 py-5 lg:flex">
        <div className="px-2">
          <Brand />
        </div>
        {/* usePathname 在动态路由上要放进 Suspense（cacheComponents） */}
        <Suspense fallback={<SidebarNavFallback />}>
          <SidebarNav />
        </Suspense>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur sm:px-8">
          <div className="flex items-center gap-1 lg:hidden">
            <MobileNav />
            <span className="font-semibold">Hearth</span>
          </div>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {/* F3 快速录入：电脑是顶栏按钮，手机是右下角悬浮 + 按钮（M6-3、M6-4） */}
            {/* 拍小票的入口按 RECEIPT_READER 显示（M6.7-7）：image → 选图；none → 直接手动填 */}
            <QuickAddButton receiptInput={receiptInputMode()} />
            {/* 读 session 的部分必须放在 Suspense 里（cacheComponents） */}
            <Suspense fallback={<div className="h-8 w-16" />}>
              <CurrentUser />
            </Suspense>
          </div>
        </header>

        {/* 手机上底部留出悬浮 + 按钮的位置（M6-4），最底下的内容能滚到按钮上面 */}
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 pb-24 sm:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}

// text reader 不做（R20.1b），这里只会是 image 或 null
function receiptInputMode(): 'image' | null {
  return getReceiptReader()?.input === 'image' ? 'image' : null;
}

async function CurrentUser() {
  const user = await getCurrentUser();
  return (
    <>
      <span className="hidden max-w-32 truncate text-sm text-muted-foreground sm:inline">
        {user.name}
      </span>
      <SignOutButton />
    </>
  );
}
