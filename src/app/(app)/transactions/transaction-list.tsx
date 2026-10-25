'use client';

import { ChevronDown, CornerDownRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLayoutEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatAud } from '@/lib/rules/money';
import { selectionState } from '@/lib/transactions/bulk-edit';
import { cn } from '@/lib/utils';
import type { TransactionListItem } from '@/server/transactions';
import { BulkBar } from './bulk-bar';
import { formatTxDate } from './format';
import { transactionDetailHref } from './href';
import {
  CategorySelect,
  MemberSelect,
  SuggestionButtons,
  type EditOptions,
  type FollowUp,
  type MemberPrompt,
  type RuleDraft,
} from './inline-edit';
import { MemberPropagationDialog } from './member-propagation-dialog';
import { SaveRuleDialog } from './save-rule-dialog';
import { isUncategorized, TxBadges } from './tx-badges';

// F8 流水列表（设计图 03）：电脑（lg 以上）是表格，窄屏是卡片列表
// 拆过的交易（R16.1）：主行显示"已拆分 N"，下面每个拆分一行，默认展开，可以收起
// 行内修改（M4-8）：只有主拆分的交易在主行改；拆过的主行不能改，每个子行改自己那个拆分
// "存成规则"对话框放在列表层：筛选"未分类"时，改完的行会从列表消失
// 批量修改（M4-9）：只能勾当前页；换页、换筛选后不在当前页的勾选自动失效

type Props = {
  items: TransactionListItem[];
  today: string;
  options: EditOptions;
  listHref: string; // 当前列表的地址，点进详情后能带着筛选和页码回来
};

export function TransactionList({ items, today, options, listHref }: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const pageIds = items.map((tx) => tx.id);
  // 只算当前页的：换页、筛选后行消失的不再算选中
  const selectedIds = pageIds.filter((id) => checked.has(id));
  const allState = selectionState(checked, pageIds);
  const setOne = (id: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const setAll = (on: boolean) => setChecked(on ? new Set(pageIds) : new Set());
  const clearSelection = () => setChecked(new Set());

  const [ruleDraft, setRuleDraft] = useState<{ key: number; draft: RuleDraft } | null>(null);
  const offerRule = (draft: RuleDraft) =>
    setRuleDraft((prev) => ({ key: (prev?.key ?? 0) + 1, draft }));
  // R16.10 的弹窗。存规则对话框开着时先不显示，等它关了再问（先存规则，再问归属人）
  const [memberPrompt, setMemberPrompt] = useState<{ key: number; prompt: MemberPrompt } | null>(
    null,
  );
  const askMember = (prompt: MemberPrompt) =>
    setMemberPrompt((prev) => ({ key: (prev?.key ?? 0) + 1, prompt }));
  const followUp: FollowUp = { offerRule, askMember };

  // cacheComponents 下离开页面时 Next 用 <Activity> 把页面藏起来，state 会留着
  // 勾选、"存成规则"和归属人联动的对话框是一次性的，页面被隐藏时清掉；拆分的展开、收起保留
  // 见 docs/tech-stack.md 2. 关键约定 "页面状态"
  useLayoutEffect(
    () => () => {
      setChecked(new Set());
      setRuleDraft(null);
      setMemberPrompt(null);
    },
    [],
  );
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const rowProps = (tx: TransactionListItem) => ({
    tx,
    today,
    expanded: !collapsed.has(tx.id),
    onToggle: () => toggle(tx.id),
    options,
    followUp,
    selected: checked.has(tx.id),
    onSelect: (on: boolean) => setOne(tx.id, on),
    detailHref: transactionDetailHref(tx.id, listHref),
  });

  return (
    <>
      <div className="hidden rounded-lg border lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 pl-4">
                <Checkbox
                  aria-label="全选当前页"
                  checked={
                    allState === 'all' ? true : allState === 'some' ? 'indeterminate' : false
                  }
                  onCheckedChange={(v) => setAll(v === true)}
                />
              </TableHead>
              <TableHead className="w-24">日期</TableHead>
              <TableHead className="pr-6 text-right">金额</TableHead>
              <TableHead>分类</TableHead>
              <TableHead>账户</TableHead>
              <TableHead>归属人</TableHead>
              <TableHead className="pr-4">商家</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((tx) => (
              <TableRows key={tx.id} {...rowProps(tx)} />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-2 lg:hidden">
        <label className="flex w-fit items-center gap-2 px-1 text-sm text-muted-foreground">
          <Checkbox
            checked={allState === 'all' ? true : allState === 'some' ? 'indeterminate' : false}
            onCheckedChange={(v) => setAll(v === true)}
          />
          全选当前页
        </label>
        <ul className="flex flex-col gap-2">
          {items.map((tx) => (
            <TxCard key={tx.id} {...rowProps(tx)} />
          ))}
        </ul>
      </div>

      {selectedIds.length > 0 && (
        <>
          {/* 给底部操作栏留位置，最后几行不被挡住 */}
          <div aria-hidden className="h-28 lg:h-16" />
          <BulkBar
            selectedIds={selectedIds}
            options={options}
            onDone={clearSelection}
            onClear={clearSelection}
          />
        </>
      )}

      {ruleDraft && (
        <SaveRuleDialog
          key={ruleDraft.key}
          draft={ruleDraft.draft}
          onClose={() => setRuleDraft(null)}
        />
      )}

      {memberPrompt && !ruleDraft && (
        <MemberPropagationDialog
          key={memberPrompt.key}
          prompt={memberPrompt.prompt}
          onClose={() => setMemberPrompt(null)}
        />
      )}
    </>
  );
}

type RowProps = {
  tx: TransactionListItem;
  today: string;
  expanded: boolean;
  onToggle: () => void;
  options: EditOptions;
  followUp: FollowUp;
  selected: boolean;
  onSelect: (on: boolean) => void;
  detailHref: string;
};

function RowCheckbox({
  merchant,
  selected,
  onSelect,
  className,
}: Pick<RowProps, 'selected' | 'onSelect'> & { merchant: string; className?: string }) {
  return (
    <Checkbox
      aria-label={`选中 ${merchant}`}
      checked={selected}
      onCheckedChange={(v) => onSelect(v === true)}
      className={className}
    />
  );
}

// 点一整行进交易详情（2026-10-24）。点到勾选框、下拉、按钮、链接时不跳
// 下拉内容在 portal 里，React 事件仍会冒泡到行上，所以只认 DOM 上真的在这一行里的点击
function useRowClick(href: string) {
  const router = useRouter();
  return (e: React.MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target)) return;
    if (target.closest('a, button, input, label, [role="checkbox"], [role="combobox"]')) return;
    if (window.getSelection()?.toString()) return; // 在选文字
    router.push(href);
  };
}

// 商家名是普通文字，点它和点行的其他地方一样进详情（design/README 第 3 节，2026-10-25）
function Merchant({ merchant }: { merchant: string }) {
  return <span className="font-medium break-words">{merchant}</span>;
}

function Amount({ cents, className }: { cents: number; className?: string }) {
  return (
    <span className={cn('tabular-nums', cents > 0 && 'text-green-700', className)}>
      {cents > 0 ? '+' : ''}
      {formatAud(cents)}
    </span>
  );
}

function SplitToggle({
  count,
  expanded,
  onToggle,
}: Pick<RowProps, 'expanded' | 'onToggle'> & { count: number }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={expanded}
      onClick={onToggle}
      className="-ml-2 h-7 gap-1 px-2 font-normal"
    >
      已拆分 {count}
      <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
    </Button>
  );
}

// ---------- 电脑：表格 ----------

function TableRows({
  tx,
  today,
  expanded,
  onToggle,
  options,
  followUp,
  selected,
  onSelect,
  detailHref,
}: RowProps) {
  const isSplit = tx.splits.length > 1;
  const primary = tx.splits[0];
  const uncategorized = tx.splits.some(isUncategorized);
  const onRowClick = useRowClick(detailHref);
  return (
    <>
      <TableRow
        data-state={selected ? 'selected' : undefined}
        onClick={onRowClick}
        className={cn(
          'cursor-pointer',
          uncategorized && 'bg-amber-50/60',
          isSplit && expanded && 'border-b-0',
        )}
      >
        <TableCell className="pl-4 align-top">
          <RowCheckbox
            merchant={tx.merchant}
            selected={selected}
            onSelect={onSelect}
            className="mt-0.5"
          />
        </TableCell>
        <TableCell className="align-top whitespace-nowrap text-muted-foreground">
          {formatTxDate(tx.date, today)}
        </TableCell>
        <TableCell className="pr-6 text-right whitespace-nowrap align-top font-medium">
          <Amount cents={tx.amountCents} />
        </TableCell>
        <TableCell className="align-top">
          {isSplit ? (
            <SplitToggle count={tx.splits.length} expanded={expanded} onToggle={onToggle} />
          ) : (
            primary && (
              <CategorySelect tx={tx} split={primary} options={options} followUp={followUp} />
            )
          )}
        </TableCell>
        <TableCell className="align-top">
          {tx.account.name}
          {tx.cardLast4 && (
            <span className="ml-1 text-xs text-muted-foreground">卡 {tx.cardLast4}</span>
          )}
        </TableCell>
        <TableCell className="align-top">
          {!isSplit && primary && (
            <MemberSelect tx={tx} split={primary} options={options} followUp={followUp} />
          )}
        </TableCell>
        <TableCell className="pr-4 align-top whitespace-normal">
          <div className="flex max-w-96 flex-wrap items-center gap-1.5">
            <Merchant merchant={tx.merchant} />
            <TxBadges tx={tx} />
            {tx.transferStatus === 'suggested' && <SuggestionButtons transactionId={tx.id} />}
          </div>
          {/* 脱敏后的原始描述（R2.3）。只占一行，悬停看完整的 */}
          <div
            title={tx.rawDescription}
            className="mt-0.5 max-w-96 truncate font-mono text-xs text-muted-foreground"
          >
            {tx.rawDescription}
          </div>
        </TableCell>
      </TableRow>
      {isSplit &&
        expanded &&
        tx.splits.map((s, i) => (
          <TableRow
            key={s.id}
            onClick={onRowClick}
            className={cn(
              'cursor-pointer bg-muted/40 text-muted-foreground hover:bg-muted/60',
              i < tx.splits.length - 1 && 'border-b-0',
            )}
          >
            <TableCell className="pl-4" />
            <TableCell />
            <TableCell className="pr-6 text-right">
              <Amount cents={s.amountCents} />
            </TableCell>
            <TableCell className="text-foreground">
              <CategorySelect tx={tx} split={s} options={options} followUp={followUp} />
            </TableCell>
            <TableCell />
            <TableCell className="text-foreground">
              <MemberSelect tx={tx} split={s} options={options} followUp={followUp} />
            </TableCell>
            <TableCell className="pr-4 whitespace-normal">
              <span className="flex items-center gap-1.5">
                <CornerDownRight className="size-3.5 shrink-0" />
                {s.isPrimary ? '主拆分' : (s.note ?? '拆出的部分')}
              </span>
            </TableCell>
          </TableRow>
        ))}
    </>
  );
}

// ---------- 窄屏：卡片 ----------

function TxCard({
  tx,
  today,
  expanded,
  onToggle,
  options,
  followUp,
  selected,
  onSelect,
  detailHref,
}: RowProps) {
  const isSplit = tx.splits.length > 1;
  const primary = tx.splits[0];
  const uncategorized = tx.splits.some(isUncategorized);
  const onRowClick = useRowClick(detailHref);
  return (
    <li
      onClick={onRowClick}
      className={cn(
        'flex cursor-pointer flex-col gap-1.5 rounded-lg border bg-card p-3 text-sm',
        uncategorized && 'border-amber-200 bg-amber-50/60',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <RowCheckbox
            merchant={tx.merchant}
            selected={selected}
            onSelect={onSelect}
            className="mr-0.5"
          />
          <Merchant merchant={tx.merchant} />
          <TxBadges tx={tx} />
        </div>
        <Amount cents={tx.amountCents} className="shrink-0 font-medium" />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{formatTxDate(tx.date, today)}</span>
        <span>·</span>
        <span>{tx.account.name}</span>
      </div>
      {tx.transferStatus === 'suggested' && <SuggestionButtons transactionId={tx.id} />}
      {!isSplit && primary && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <CategorySelect tx={tx} split={primary} options={options} followUp={followUp} />
          <MemberSelect tx={tx} split={primary} options={options} followUp={followUp} />
        </div>
      )}
      <div title={tx.rawDescription} className="truncate font-mono text-xs text-muted-foreground">
        {tx.rawDescription}
      </div>
      {isSplit && (
        <div className="text-xs">
          <SplitToggle count={tx.splits.length} expanded={expanded} onToggle={onToggle} />
          {expanded && (
            <ul className="mt-1 flex flex-col gap-1 border-l pl-3">
              {tx.splits.map((s) => (
                <li key={s.id} className="flex items-start justify-between gap-3">
                  <span className="flex min-w-0 flex-wrap items-center gap-1">
                    <CategorySelect tx={tx} split={s} options={options} followUp={followUp} />
                    <MemberSelect tx={tx} split={s} options={options} followUp={followUp} />
                  </span>
                  <Amount cents={s.amountCents} className="shrink-0" />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
