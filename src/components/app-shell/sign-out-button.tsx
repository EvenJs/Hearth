'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

export function SignOutButton() {
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
    <Button variant="outline" size="sm" onClick={handleSignOut} disabled={pending}>
      {pending ? '退出中…' : '退出'}
    </Button>
  );
}
