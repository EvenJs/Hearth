'use client';

// R13 改完分类后"存成规则"（M4-8）。三步：
// 1. 关键词，默认 suggestKeyword(merchant)，可以改；匹配方式固定 contains（R16.9）
// 2. 已有同样的关键词、指向不同分类 → 提示，确认后改成新分类（R16.6）；分类相同直接下一步
// 3. 现查会改几笔，问"要对 N 笔未分类和规则分类的交易应用吗"（R7.2）；0 笔就直接结束
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { suggestKeyword } from '@/lib/rules/keyword';
import { createRuleAction, previewReapplyAction, reapplyRulesAction } from './actions';
import type { RuleDraft } from './inline-edit';

type Step =
  | { name: 'keyword' }
  | { name: 'conflict'; message: string }
  | { name: 'apply'; changeCount: number; skippedCount: number };

// 父组件用 key 让每次新的 draft 重新开始
export function SaveRuleDialog({ draft, onClose }: { draft: RuleDraft; onClose: () => void }) {
  const [keyword, setKeyword] = useState(() => suggestKeyword(draft.merchant));
  const [step, setStep] = useState<Step>({ name: 'keyword' });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // 规则存好了（新建、没变或改了），进入"是否应用"
  async function askApply(savedMessage: string) {
    const p = await previewReapplyAction();
    if (!p.ok) {
      toast.error(p.message);
      onClose();
      return;
    }
    if (p.changeCount === 0) {
      toast.success(`${savedMessage}，没有需要重新分类的交易`);
      onClose();
      return;
    }
    setStep({ name: 'apply', changeCount: p.changeCount, skippedCount: p.skippedCount });
  }

  function save(overwrite: boolean) {
    setError(null);
    startTransition(async () => {
      const r = await createRuleAction({ keyword, categoryId: draft.categoryId, overwrite });
      if (!r.ok) {
        if (r.reason === 'conflict') setStep({ name: 'conflict', message: r.message });
        else setError(r.message);
        return;
      }
      await askApply(r.status === 'unchanged' ? '已经有这条规则' : '规则已保存');
    });
  }

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
        {step.name === 'keyword' && (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              save(false);
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>存成规则？</AlertDialogTitle>
              <AlertDialogDescription>
                以后商家包含这个关键词的交易，自动分到 <strong>{draft.categoryLabel}</strong>。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="rule-keyword">关键词</Label>
              <Input
                id="rule-keyword"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                maxLength={100}
                autoFocus
                className="font-mono"
                aria-invalid={error !== null}
              />
              <p className="text-xs text-muted-foreground">
                商家：<span className="font-mono">{draft.merchant}</span>。不区分大小写，保存时转成大写。
              </p>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel type="button" disabled={pending}>
                不用了
              </AlertDialogCancel>
              <Button type="submit" disabled={pending || keyword.trim() === ''}>
                {pending && <Loader2 className="animate-spin" />}
                保存规则
              </Button>
            </AlertDialogFooter>
          </form>
        )}

        {step.name === 'conflict' && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>关键词已经有规则了</AlertDialogTitle>
              <AlertDialogDescription>
                {step.message}。要改成 <strong>{draft.categoryLabel}</strong> 吗？
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setStep({ name: 'keyword' })}
              >
                换个关键词
              </Button>
              <Button type="button" disabled={pending} onClick={() => save(true)}>
                {pending && <Loader2 className="animate-spin" />}
                改成新分类
              </Button>
            </AlertDialogFooter>
          </>
        )}

        {step.name === 'apply' && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>应用到已有交易？</AlertDialogTitle>
              <AlertDialogDescription>
                要对 {step.changeCount} 笔未分类和规则分类的交易应用吗？手动改过的不会动。
                {step.skippedCount > 0 && ` 有 ${step.skippedCount} 笔拆过的交易会跳过。`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button" disabled={pending}>
                先不用
              </AlertDialogCancel>
              <Button type="button" disabled={pending} onClick={apply}>
                {pending && <Loader2 className="animate-spin" />}
                应用到 {step.changeCount} 笔
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
