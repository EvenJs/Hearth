'use client';

// 交易详情"删除小票"（R20.7）：只删 receipt 那行，拆分不动。删完详情页又出现"上传小票"
import { Loader2, Trash2 } from 'lucide-react';
import { useLayoutEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { deleteReceiptAction } from '@/components/receipt/actions';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export function DeleteReceiptButton({ receiptId }: { receiptId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // 对话框是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(() => () => setOpen(false), []);

  function remove() {
    startTransition(async () => {
      const r = await deleteReceiptAction(receiptId);
      setOpen(false);
      if (r.ok) toast.success('小票已删除，拆分没变');
      else toast.error(r.message);
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 />
        删除小票
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !o && !pending && setOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这张小票？</AlertDialogTitle>
            <AlertDialogDescription>
              只删小票和商品明细，拆分不会变。删了以后可以重新上传。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault(); // 等删完再关
                remove();
              }}
            >
              {pending && <Loader2 className="animate-spin" />}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
