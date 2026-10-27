'use client';

// 归档确认（R19.4）。有规则指向它（一级包括二级）时不能归档：
// 提示"有 N 条规则指向这个分类，先去规则页改掉或删掉"，链接到规则页带 ?category=<一级 id>
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
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
import type { AdminCategoryItem, AdminTopCategory } from '@/server/categories';
import { archiveCategoryAction } from './actions';

type Blocked = { message: string; ruleFilterTopId: string };

export function ArchiveCategoryDialog({
  item,
  top,
  onClose,
  onArchived,
}: {
  item: AdminCategoryItem;
  top: AdminTopCategory | null; // null = 归档的是一级
  onClose: () => void;
  onArchived: (message: string) => void;
}) {
  // 列表里的规则数（一级已经合计了二级）> 0 就直接提示，不用先点一次；
  // 保存时服务端还会再查一次，期间有人加了规则也会挡住
  const [blocked, setBlocked] = useState<Blocked | null>(
    item.ruleCount > 0
      ? {
          message: `有 ${item.ruleCount} 条规则指向这个分类，先去规则页改掉或删掉`,
          ruleFilterTopId: top?.id ?? item.id,
        }
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function archive() {
    setError(null);
    startTransition(async () => {
      const r = await archiveCategoryAction(item.id);
      if (r.ok) {
        onArchived(`${item.nameEn} 已归档`);
        return;
      }
      if (r.reason === 'has_rules') {
        setBlocked({ message: r.message, ruleFilterTopId: r.ruleFilterTopId });
        return;
      }
      setError(r.message);
    });
  }

  if (blocked) {
    return (
      <AlertDialog open onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-600" />
              不能归档 {item.nameEn}
            </AlertDialogTitle>
            <AlertDialogDescription>{blocked.message}。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">知道了</AlertDialogCancel>
            <Button asChild>
              <Link href={`/settings/rules?category=${blocked.ruleFilterTopId}`}>
                去规则页
                <ArrowRight />
              </Link>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>归档 {item.nameEn}？</AlertDialogTitle>
          <AlertDialogDescription>
            {top === null && '下面所有二级（包括 Other）会一起归档。'}
            归档以后改分类、拆分、快速录入、规则里都不能再选它。已有交易不动，看板照常统计。随时可以取消归档。
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
          <Button type="button" disabled={pending} onClick={archive}>
            {pending && <Loader2 className="animate-spin" />}
            归档
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
