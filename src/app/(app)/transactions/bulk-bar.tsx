'use client';

// F8 批量修改的操作栏（M4-9，设计图 03-transactions-bulk）：勾选后贴在页面底部
// 下拉里选了就执行，一次只改一样（分类或归属人）；跳过的规则在 bulkUpdate 里（R16.1、R16.2）
// 批量改分类不弹"存成规则"：选中的交易商家各不相同（R16.9 针对的是单笔修改）
import { Loader2, Tag, User, X } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { bulkResultMessage, type BulkField } from '@/lib/transactions/bulk-edit';
import { bulkUpdateAction } from './actions';
import type { EditOptions } from './inline-edit';

type Props = {
  selectedIds: string[];
  options: EditOptions;
  onDone: () => void;
  onClear: () => void;
};

const triggerClass =
  'h-8 gap-1.5 border-background/30 bg-transparent text-background shadow-none hover:bg-background/10 data-[placeholder]:text-background dark:bg-transparent dark:hover:bg-background/10 [&_svg:not([class*="text-"])]:text-background/70';

export function BulkBar({ selectedIds, options, onDone, onClear }: Props) {
  const [pending, startTransition] = useTransition();

  function run(field: BulkField, id: string) {
    const change = field === 'category' ? { categoryId: id } : { memberId: id };
    startTransition(async () => {
      const r = await bulkUpdateAction({ transactionIds: selectedIds, ...change });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const message = bulkResultMessage(field, r);
      if (r.skippedCount > 0) toast.warning(message);
      else toast.success(message);
      onDone();
    });
  }

  return (
    <div
      role="region"
      aria-label="批量修改"
      className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:left-60 lg:pb-6"
    >
      <div className="flex w-full max-w-xl flex-wrap items-center gap-2 rounded-xl bg-foreground px-3 py-2 text-sm text-background shadow-lg sm:w-auto sm:flex-nowrap">
        <span className="mr-auto px-1 whitespace-nowrap sm:mr-1">
          已选 <strong className="tabular-nums">{selectedIds.length}</strong> 笔
        </span>
        {pending && <Loader2 className="size-4 animate-spin" aria-label="保存中" />}

        <Select value="" onValueChange={(id) => run('category', id)} disabled={pending}>
          <SelectTrigger size="sm" aria-label="改分类" className={triggerClass}>
            <Tag />
            <SelectValue placeholder="改分类" />
          </SelectTrigger>
          <SelectContent position="popper" side="top" align="center" className="max-h-80">
            {options.categoryGroups.map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.options.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        <Select value="" onValueChange={(id) => run('member', id)} disabled={pending}>
          <SelectTrigger size="sm" aria-label="改归属人" className={triggerClass}>
            <User />
            <SelectValue placeholder="改归属人" />
          </SelectTrigger>
          <SelectContent position="popper" side="top" align="center">
            {options.members.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={onClear}
          className="h-8 gap-1 px-2 text-background hover:bg-background/10 hover:text-background"
        >
          <X />
          取消选择
        </Button>
      </div>
    </div>
  );
}
