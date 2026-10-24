'use client';

// F8 行内修改（M4-8，设计图 03）：分类、归属人下拉，建议转账的"确认""不是"
// 改的都是一个拆分（R16.1）；auto / confirmed 转账分类只读（R16.2）；下拉选项按 R16.3
import { Check, Loader2, X } from 'lucide-react';
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
import {
  isCategoryLocked,
  shouldOfferRule,
  type CategoryOption,
  type CategoryOptionGroup,
} from '@/lib/transactions/inline-edit';
import { cn } from '@/lib/utils';
import type { SplitView, TransactionListItem } from '@/server/transactions';
import {
  resolveSuggestionAction,
  updateSplitCategoryAction,
  updateSplitMemberAction,
} from './actions';
import { categoryLabel } from './format';
import { CategoryTag } from './tx-badges';

export type EditOptions = {
  categoryGroups: CategoryOptionGroup[];
  members: { id: string; name: string }[];
};

// 改完分类后要弹"存成规则"时，交给列表层的对话框（行可能因为筛选条件消失）
export type RuleDraft = { merchant: string; categoryId: string; categoryLabel: string };

const triggerClass =
  'h-auto min-h-7 max-w-full gap-1 border-transparent bg-transparent px-1 py-0.5 shadow-none hover:bg-muted data-[state=open]:bg-muted dark:bg-transparent';

function findOption(groups: CategoryOptionGroup[], id: string): CategoryOption | undefined {
  for (const g of groups) {
    const o = g.options.find((x) => x.id === id);
    if (o) return o;
  }
  return undefined;
}

// ---------- 分类 ----------

export function CategorySelect({
  tx,
  split,
  options,
  onOfferRule,
}: {
  tx: Pick<TransactionListItem, 'merchant' | 'transferStatus'>;
  split: SplitView;
  options: EditOptions;
  onOfferRule: (draft: RuleDraft) => void;
}) {
  const [pending, startTransition] = useTransition();

  // R16.2：内部转账只读
  if (isCategoryLocked(tx.transferStatus)) return <CategoryTag category={split.category} />;

  const groups = options.categoryGroups;
  // 当前分类不在可选项里（比如已归档），加一个不能选的项，让下拉能显示它
  const current = findOption(groups, split.category.id);

  function onChange(categoryId: string) {
    if (categoryId === split.category.id) return;
    const next = findOption(groups, categoryId);
    if (!next) return;
    startTransition(async () => {
      const r = await updateSplitCategoryAction({ splitId: split.id, categoryId });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (shouldOfferRule({ isPrimary: split.isPrimary, changed: r.changed, newKind: next.kind })) {
        onOfferRule({ merchant: tx.merchant, categoryId, categoryLabel: next.label });
      }
    });
  }

  return (
    <Select value={split.category.id} onValueChange={onChange} disabled={pending}>
      <SelectTrigger size="sm" aria-label="分类" className={triggerClass}>
        <SelectValue>
          <CategoryTag category={split.category} />
          {pending && <Loader2 className="animate-spin" />}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="max-h-80">
        {!current && (
          <SelectItem value={split.category.id} disabled>
            {categoryLabel(split.category)}
          </SelectItem>
        )}
        {groups.map((g) => (
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
  );
}

// ---------- 归属人 ----------

export function MemberSelect({ split, options }: { split: SplitView; options: EditOptions }) {
  const [pending, startTransition] = useTransition();
  const known = options.members.some((m) => m.id === split.member.id);

  function onChange(memberId: string) {
    if (memberId === split.member.id) return;
    startTransition(async () => {
      const r = await updateSplitMemberAction({ splitId: split.id, memberId });
      if (!r.ok) toast.error(r.message);
    });
  }

  return (
    <Select value={split.member.id} onValueChange={onChange} disabled={pending}>
      <SelectTrigger size="sm" aria-label="归属人" className={triggerClass}>
        <SelectValue>
          {split.member.name}
          {pending && <Loader2 className="animate-spin" />}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {!known && (
          <SelectItem value={split.member.id} disabled>
            {split.member.name}
          </SelectItem>
        )}
        {options.members.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------- 建议转账（R6.3） ----------

export function SuggestionButtons({
  transactionId,
  className,
}: {
  transactionId: string;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();

  function run(action: 'confirm' | 'reject') {
    startTransition(async () => {
      const r = await resolveSuggestionAction({ transactionId, action });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(action === 'confirm' ? '已确认是内部转账，两边一起改了' : '已标记为不是转账');
    });
  }

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <Button
        type="button"
        size="sm"
        className="h-6 gap-1 px-2 text-xs"
        disabled={pending}
        onClick={() => run('confirm')}
      >
        {pending ? <Loader2 className="animate-spin" /> : <Check />}
        确认
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 gap-1 px-2 text-xs"
        disabled={pending}
        onClick={() => run('reject')}
      >
        <X />
        不是
      </Button>
    </span>
  );
}
