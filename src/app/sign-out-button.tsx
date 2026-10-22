'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    const { error } = await authClient.signOut();
    if (error) {
      setPending(false);
      toast.error('退出失败，请稍后再试');
      return;
    }
    router.replace('/login');
    router.refresh();
  }

  return (
    <Button variant="outline" size="sm" onClick={handleSignOut} disabled={pending}>
      {pending ? '退出中…' : '退出'}
    </Button>
  );
}
