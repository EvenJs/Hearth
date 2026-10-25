'use client';

// R16.10 行内改了主拆分的归属人后，同商家的交易要不要一起改（M5.5-4）
// 确认后服务端在一个事务里重新算一遍再改，实际笔数以返回的为准
import { Loader2 } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { applyMemberPropagationAction } from './actions';
import type { MemberPrompt } from './inline-edit';

export function MemberPropagationDialog({
  prompt,
  onClose,
}: {
  prompt: MemberPrompt;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function apply() {
    startTransition(async () => {
      const r = await applyMemberPropagationAction({
        transactionId: prompt.transactionId,
        memberId: prompt.memberId,
      });
      if (!r.ok) toast.error(r.message);
      else if (r.updatedCount > 0) {
        toast.success(`已把 ${r.updatedCount} 笔改成 ${prompt.memberName}`);
      } else toast.info('没有需要改的了');
      onClose();
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>同商家一起改？</AlertDialogTitle>
          <AlertDialogDescription>
            商家含 <span className="font-medium text-foreground">{prompt.keyword}</span> 的还有{' '}
            {prompt.count} 笔归属人不是 {prompt.memberName}，要一起改吗？
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>不用</AlertDialogCancel>
          <Button onClick={apply} disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            一起改
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
