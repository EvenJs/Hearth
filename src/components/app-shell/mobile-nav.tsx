'use client';

import { Menu } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Brand } from './brand';
import { SidebarNav } from './sidebar-nav';

// 手机和窄屏：侧边栏收进 Sheet，顶栏左边一个菜单按钮
export function MobileNav() {
  const [open, setOpen] = useState(false);
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
          <SidebarNav onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
