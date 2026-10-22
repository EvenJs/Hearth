'use client';

import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function ToastButton() {
  return (
    <Button variant="outline" onClick={() => toast.success('已保存')}>
      测试提示
    </Button>
  );
}
