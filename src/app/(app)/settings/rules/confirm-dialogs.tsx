'use client';

// 删除确认（R18.3）和"要对 N 笔应用吗"（R18.4、R7.2）
import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
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
import type { RuleListItem } from '@/server/rules';
import { reapplyRulesAction } from '../../transactions/actions';
import { deleteRuleAction } from './actions';

export type ApplyPreview = { changeCount: number; skippedCount: number };

// R18.3：写明命中几笔；删除只删规则，不动已经分好类的交易
export function DeleteRuleDialog({
  rule,
  onClose,
  onDeleted,
}: {
  rule: RuleListItem;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function remove() {
    setError(null);
    startTransition(async () => {
      const r = await deleteRuleAction(rule.id);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      onDeleted();
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            删除规则 <span className="font-mono">{rule.keyword}</span>？
          </AlertDialogTitle>
          <AlertDialogDescription>
            命中 {rule.hits} 笔，删除后这些交易的分类不变。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            取消
          </AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={pending} onClick={remove}>
            {pending && <Loader2 className="animate-spin" />}
            删除
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// R18.4：N 是 R7.2 的预览数。文案和 F8 存规则后的一样
export function ApplyRulesDialog({
  preview,
  onClose,
}: {
  preview: ApplyPreview;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function apply() {
    startTransition(async () => {
      const r = await reapplyRulesAction();
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(
        r.skippedCount > 0
          ? `已重新分类 ${r.updatedCount} 笔，跳过 ${r.skippedCount} 笔拆过的交易`
          : `已重新分类 ${r.updatedCount} 笔`,
      );
      onClose();
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>应用到已有交易？</AlertDialogTitle>
          <AlertDialogDescription>
            要对 {preview.changeCount} 笔未分类和规则分类的交易应用吗？手动改过的不会动。
            {preview.skippedCount > 0 && ` 有 ${preview.skippedCount} 笔拆过的交易会跳过。`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            先不用
          </AlertDialogCancel>
          <Button type="button" disabled={pending} onClick={apply}>
            {pending && <Loader2 className="animate-spin" />}
            应用到 {preview.changeCount} 笔
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
