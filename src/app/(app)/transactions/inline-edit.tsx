'use client';

// F8 行内修改（M4-8，设计图 03）：分类、归属人下拉，建议转账的"确认""不是"
// 改的都是一个拆分（R16.1）；auto / confirmed 转账分类只读（R16.2）；下拉选项按 R16.3
// 改完之后的追问（M5.5-4）：存成规则（R16.9）、同商家一起改归属人（R16.10）
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  isCategoryLocked,
  type CategoryOption,
  type CategoryOptionGroup,
} from '@/lib/transactions/inline-edit';
import type { PickerSections } from '@/lib/transactions/category-picker';
import { cn } from '@/lib/utils';
import type { SplitView, TransactionListItem } from '@/server/transactions';
import {
  previewMemberPropagationAction,
  resolveSuggestionAction,
  ruleOfferAction,
  updateSplitCategoryAction,
  updateSplitMemberAction,
} from './actions';
import { CategoryPicker } from './category-picker';
import { CategoryTag } from './tx-badges';

export type EditOptions = {
  categoryGroups: CategoryOptionGroup[]; // 查分类的 label、kind（R16.9 要用）
  categorySections: PickerSections; // 可折叠下拉的选项，和 categoryGroups 同一个范围（R16.3）
  members: { id: string; name: string }[];
};

// 改完分类后要弹"存成规则"时，交给列表层的对话框（行可能因为筛选条件消失）
export type RuleDraft = { merchant: string; categoryId: string; categoryLabel: string };

// R16.10 改完归属人后的弹窗内容，交给列表层
export type MemberPrompt = {
  transactionId: string;
  memberId: string;
  memberName: string;
  keyword: string;
  count: number;
};

// 列表层的对话框入口
export type FollowUp = {
  offerRule: (draft: RuleDraft) => void;
  askMember: (prompt: MemberPrompt) => void;
};

// R16.9：dialog 直接打开存规则对话框；toast 只在提示里放"存成规则"按钮（这个商家目前只有这一笔）
export async function offerRuleAfterChange(
  input: { transactionId: string; isPrimary: boolean; kind: CategoryOption['kind'] },
  draft: RuleDraft,
  offerRule: (draft: RuleDraft) => void,
) {
  const offer = await ruleOfferAction({
    transactionId: input.transactionId,
    isPrimary: input.isPrimary,
    newKind: input.kind,
  });
  if (offer === 'dialog') offerRule(draft);
  if (offer === 'toast') {
    toast.success(`已改成 ${draft.categoryLabel}`, {
      action: { label: '存成规则', onClick: () => offerRule(draft) },
    });
  }
}

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
  followUp,
}: {
  tx: Pick<TransactionListItem, 'id' | 'merchant' | 'transferStatus'>;
  split: SplitView;
  options: EditOptions;
  followUp: FollowUp;
}) {
  const [pending, startTransition] = useTransition();

  // R16.2：内部转账只读
  if (isCategoryLocked(tx.transferStatus)) return <CategoryTag category={split.category} />;

  const groups = options.categoryGroups;

  function onChange(categoryId: string | null) {
    if (!categoryId || categoryId === split.category.id) return;
    const next = findOption(groups, categoryId);
    if (!next) return;
    startTransition(async () => {
      const r = await updateSplitCategoryAction({ splitId: split.id, categoryId });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (!r.changed) return;
      await offerRuleAfterChange(
        { transactionId: tx.id, isPrimary: split.isPrimary, kind: next.kind },
        { merchant: tx.merchant, categoryId, categoryLabel: next.label },
        followUp.offerRule,
      );
    });
  }

  return (
    <CategoryPicker
      sections={options.categorySections}
      value={split.category.id}
      onSelect={onChange}
      mode="edit"
      disabled={pending}
    >
      <button
        type="button"
        aria-label="分类"
        className={cn(triggerClass, 'inline-flex items-center rounded-md border')}
      >
        <CategoryTag category={split.category} />
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ChevronDown className="size-4 opacity-50" />
        )}
      </button>
    </CategoryPicker>
  );
}

// ---------- 归属人 ----------

export function MemberSelect({
  tx,
  split,
  options,
  followUp,
}: {
  tx: Pick<TransactionListItem, 'id'>;
  split: SplitView;
  options: EditOptions;
  followUp: FollowUp;
}) {
  const [pending, startTransition] = useTransition();
  const known = options.members.some((m) => m.id === split.member.id);

  function onChange(memberId: string) {
    if (memberId === split.member.id) return;
    startTransition(async () => {
      const r = await updateSplitMemberAction({ splitId: split.id, memberId });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      // R16.10：只问主拆分；同商家没有要改的（count = 0）不弹
      if (!r.changed || !split.isPrimary) return;
      const p = await previewMemberPropagationAction({ splitId: split.id });
      if (p && p.count > 0) {
        followUp.askMember({ transactionId: tx.id, memberId, ...p });
      }
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
