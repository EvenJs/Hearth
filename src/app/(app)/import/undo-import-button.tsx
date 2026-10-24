'use client';

// R12.1 撤销导入的按钮和弹窗（M3-9）。导入历史页和导入结果页共用
// 点击时现查 getUndoPreview：有手动改过的或确认的 pending → 弹窗列出笔数，确认后才撤销；都没有 → 直接撤销
import { Loader2, PencilLine, RotateCcw, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
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
import { cn } from '@/lib/utils';
import { previewUndoAction, undoImportAction } from './actions';

type Prompt = {
  fileName: string;
  deleteCount: number;
  manualEditedCount: number;
  confirmedPendingCount: number;
};

export function UndoImportButton({
  batchId,
  // history：留在历史页，列表刷新后这一条消失；result：结果页撤销后跳到历史页
  after,
  label = '撤销',
  className,
}: {
  batchId: string;
  after: 'history' | 'result';
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  function runUndo() {
    startTransition(async () => {
      const r = await undoImportAction(batchId);
      if (!r.ok) {
        setPrompt(null);
        toast.error(r.message);
        router.refresh();
        return;
      }
      setPrompt(null);
      toast.success(
        r.restoredPendingCount > 0
          ? `已撤销：删除 ${r.deletedCount} 笔，${r.restoredPendingCount} 笔恢复成待确认`
          : `已撤销：删除 ${r.deletedCount} 笔`,
      );
      if (after === 'result') router.push('/import/history');
      else router.refresh();
    });
  }

  function onClick() {
    startTransition(async () => {
      const p = await previewUndoAction(batchId);
      if (!p.ok) {
        toast.error(p.message);
        router.refresh(); // 可能别处已经撤销或又导入了，刷新按钮状态
        return;
      }
      if (!p.prompt.needsConfirm) {
        runUndo();
        return;
      }
      setPrompt({
        fileName: p.fileName,
        deleteCount: p.deleteCount,
        manualEditedCount: p.prompt.manualEditedCount,
        confirmedPendingCount: p.prompt.confirmedPendingCount,
      });
    });
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={pending}
        className={cn('w-fit shrink-0', className)}
      >
        {pending && !prompt ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Undo2 className="size-4" />
        )}
        {label}
      </Button>

      <AlertDialog
        open={prompt !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setPrompt(null);
        }}
      >
        {prompt && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <TriangleAlert className="size-5 text-destructive" />
                撤销这次导入？
              </AlertDialogTitle>
              <AlertDialogDescription className="break-all">
                {prompt.fileName}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <ul className="flex flex-col gap-2 text-sm">
              <PromptItem icon={Trash2}>
                删除这次新增的 <strong>{prompt.deleteCount}</strong> 笔交易
              </PromptItem>
              {prompt.manualEditedCount > 0 && (
                <PromptItem icon={PencilLine} warn>
                  其中手动改过 <strong>{prompt.manualEditedCount}</strong> 笔
                  <span className="block text-xs text-muted-foreground">
                    改过的分类、归属人、拆分和备注会一起删掉
                  </span>
                </PromptItem>
              )}
              {prompt.confirmedPendingCount > 0 && (
                <PromptItem icon={RotateCcw} warn>
                  确认的手动录入 <strong>{prompt.confirmedPendingCount}</strong> 笔，恢复成待确认
                  <span className="block text-xs text-muted-foreground">
                    日期和描述保留银行的，不会改回录入时的
                  </span>
                </PromptItem>
              )}
            </ul>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
              <Button variant="destructive" onClick={runUndo} disabled={pending}>
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Undo2 className="size-4" />
                )}
                撤销本次导入
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </>
  );
}

function PromptItem({
  icon: Icon,
  warn = false,
  children,
}: {
  icon: typeof Trash2;
  warn?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={cn('flex gap-3 rounded-md bg-muted px-3 py-2.5', warn && 'bg-amber-50')}>
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', warn ? 'text-amber-600' : 'text-muted-foreground')}
      />
      <span>{children}</span>
    </li>
  );
}
