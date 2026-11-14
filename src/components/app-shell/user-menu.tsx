'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChevronDown, Loader2, LogOut, UserRound, UserRoundCog } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authClient } from '@/lib/auth-client';

// 顶栏右上角：名字 + 下拉菜单（M13-9）。"我的账号"链到设置 → 账号（M12-9）
export function UserMenu({ name }: { name: string }) {
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    const { error } = await authClient.signOut();
    if (error) {
      setPending(false);
      toast.error('退出失败，请稍后再试');
      return;
    }
    // 整页跳转而不是 router.replace：清掉客户端保留的页面状态和缓存（cacheComponents 会保留表单内容）
    window.location.replace('/login');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`${name} 的菜单`}>
          <UserRound className="sm:hidden" />
          <span className="hidden max-w-32 truncate sm:inline">{name}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href="/settings/profile">
            <UserRoundCog />
            我的账号
          </Link>
        </DropdownMenuItem>
        {/* preventDefault：菜单不关，转圈留在原地直到跳走 */}
        <DropdownMenuItem
          disabled={pending}
          onSelect={(e) => {
            e.preventDefault();
            void handleSignOut();
          }}
        >
          {pending ? <Loader2 className="animate-spin" /> : <LogOut />}
          退出
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
