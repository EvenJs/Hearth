'use client';

import { CalendarCheck, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { conditionText } from '@/lib/accounts/condition-text';
import { OUTCOME_LABELS } from '@/lib/rules/conditions';
import type { StoredCondition } from '@/server/conditions';
import { deactivateConditionAction } from './actions';
import { ConditionForm } from './condition-form';

type Props = {
  accountId: string;
  hasLinkedAccount: boolean;
  conditions: StoredCondition[]; // 只含这个账户在用的条件
  today: string;
};

// editing：null = 关闭；'new' = 添加；StoredCondition = 修改
type Editing = null | 'new' | StoredCondition;

// F13 每月条件（R24.1）：只在编辑已有、没归档的账户时出现
export function ConditionsSection({ accountId, hasLinkedAccount, conditions, today }: Props) {
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<StoredCondition | null>(null);
  const [pending, startTransition] = useTransition();

  function remove(c: StoredCondition) {
    startTransition(async () => {
      const result = await deactivateConditionAction(c.id);
      if (!result.ok) {
        toast.error(Object.values(result.errors)[0] ?? '删除失败');
        return;
      }
      setRemoving(null);
      toast.success('已删除条件，历史保留');
    });
  }

  return (
    <section className="flex flex-col gap-3 border-t px-4 pt-5 pb-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-medium">
            <CalendarCheck className="size-4" />
            每月条件
          </h3>
          <p className="text-sm text-muted-foreground">
            按银行的说明录 bonus 或免月费的条件，账户总览显示每月进度。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
          <Plus />
          加条件
        </Button>
      </div>

      {conditions.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有条件。</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {conditions.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="break-words">{conditionText(c)}</p>
                <p className="text-xs text-muted-foreground">
                  从 {c.effectiveFrom.slice(0, 7)} 起
                </p>
              </div>
              <Badge variant="secondary">{OUTCOME_LABELS[c.outcome]}</Badge>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="修改条件"
                title="修改"
                onClick={() => setEditing(c)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="删除条件"
                title="删除"
                disabled={pending}
                onClick={() => setRemoving(c)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? '加条件' : '修改条件'}</DialogTitle>
            <DialogDescription>
              {editing === 'new'
                ? '按银行写的条件录，app 不知道哪家银行是什么条件。'
                : '修改会停用旧的、建一条新的：本月起按新参数算，以前的月份照旧。'}
            </DialogDescription>
          </DialogHeader>
          {editing !== null && (
            <ConditionForm
              key={editing === 'new' ? 'new' : editing.id}
              accountId={accountId}
              hasLinkedAccount={hasLinkedAccount}
              condition={editing === 'new' ? null : editing}
              today={today}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoving(null);
        }}
      >
        {removing && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除这个条件？</AlertDialogTitle>
              <AlertDialogDescription>
                「{conditionText(removing)}」从本月起不再判断、不再提示。以前月份的历史保留，账户总览里照样能看。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
              <Button variant="destructive" onClick={() => remove(removing)} disabled={pending}>
                {pending ? '删除中…' : '删除'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </section>
  );
}
