'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Brand } from './brand';
import { SidebarNav, SidebarNavFallback } from './sidebar-nav';

// 手机和窄屏：侧边栏收进 Sheet，顶栏左边一个菜单按钮
// 点了去别的页面的链接，Sheet 先不关，链接上转圈；路径变了（新页面出来）再关（M13-3）
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="打开菜单">
          <Menu className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 gap-0 p-0">
        <SheetHeader className="p-4">
          <SheetTitle className="sr-only">菜单</SheetTitle>
          <Brand />
        </SheetHeader>
        <div className="px-3 pb-4">
          <Suspense fallback={<SidebarNavFallback onNavigate={close} />}>
            <SidebarNav onNavigate={close} />
          </Suspense>
        </div>
      </SheetContent>
      {/* usePathname 在动态路由上要放进 Suspense（cacheComponents） */}
      <Suspense fallback={null}>
        <CloseOnPathChange onChange={close} />
      </Suspense>
    </Sheet>
  );
}

function CloseOnPathChange({ onChange }: { onChange: () => void }) {
  const pathname = usePathname();
  const last = useRef(pathname);
  useEffect(() => {
    if (pathname === last.current) return;
    last.current = pathname;
    onChange();
  }, [pathname, onChange]);
  return null;
}
