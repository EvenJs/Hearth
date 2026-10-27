'use client';

// 设置 → 分类的列表（设计图 13，R19.1）
// 支出、收入两组，一级按 sort_order，点开看二级；系统分类单独列在最后，只读
// 电脑上一行几列（归属人、笔数、规则数）；手机上这些挪到名字下面一行（只要求能用）
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useLayoutEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { AdminCategoryItem, AdminTopCategory, CategoryAdminList } from '@/server/categories';
import type { Member } from '@/server/members';
import type { CategoryRef } from '@/server/transactions';
import { CategoryTag } from '../../transactions/tx-badges';
import { unarchiveCategoryAction } from './actions';
import { ArchiveCategoryDialog } from './archive-dialog';
import { CategoryDialog, type CategoryDialogMode } from './category-dialog';

type Props = {
  list: CategoryAdminList;
  members: Member[]; // 没归档的
  showArchived: boolean;
};

type Dialog =
  | { name: 'form'; mode: CategoryDialogMode }
  | { name: 'archive'; item: AdminCategoryItem; top: AdminTopCategory | null };

// 电脑上的列：名字 | 默认归属人 | 笔数 | 规则 | 操作
const ROW_GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_11rem_5.5rem_6rem_2.5rem] md:items-center';

export function tagRef(item: AdminCategoryItem, top: AdminTopCategory | null): CategoryRef {
  return {
    id: item.id,
    nameEn: item.nameEn,
    nameZh: item.nameZh,
    kind: item.kind,
    systemKey: item.systemKey,
    parent: top ? { id: top.id, nameEn: top.nameEn, nameZh: top.nameZh } : null,
  };
}

export function CategoriesView({ list, members, showArchived }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [pending, startTransition] = useTransition();

  // 对话框是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(() => () => setDialog(null), []);

  const memberName = (id: string | null) =>
    id === null ? null : (members.find((m) => m.id === id)?.name ?? '（已归档的归属人）');

  function toggle(id: string, value?: boolean) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (value ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setShowArchived(value: boolean) {
    startTransition(() =>
      router.replace(value ? `${pathname}?archived=1` : pathname, { scroll: false }),
    );
  }

  function unarchive(item: AdminCategoryItem) {
    startTransition(async () => {
      const r = await unarchiveCategoryAction(item.id);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${item.nameEn} 已取消归档`);
    });
  }

  const actions: RowActions = {
    onEdit: (item, top) => setDialog({ name: 'form', mode: { kind: 'edit', item, top } }),
    onAddChild: (top) => setDialog({ name: 'form', mode: { kind: 'create-child', top } }),
    onArchive: (item, top) => setDialog({ name: 'archive', item, top }),
    onUnarchive: unarchive,
    busy: pending,
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="show-archived"
            checked={showArchived}
            onCheckedChange={(v) => setShowArchived(v === true)}
          />
          <Label htmlFor="show-archived" className="font-normal">
            显示已归档
          </Label>
        </div>
        <Button onClick={() => setDialog({ name: 'form', mode: { kind: 'create-top' } })}>
          <Plus />
          新建一级分类
        </Button>
      </div>

      <Group
        title="支出"
        tops={list.expense}
        showArchived={showArchived}
        open={open}
        onToggle={toggle}
        memberName={memberName}
        actions={actions}
      />
      <Group
        title="收入"
        tops={list.income}
        showArchived={showArchived}
        open={open}
        onToggle={toggle}
        memberName={memberName}
        actions={actions}
      />
      <SystemGroup tops={list.system} />

      {dialog?.name === 'form' && (
        <CategoryDialog
          key={dialog.mode.kind === 'edit' ? dialog.mode.item.id : dialog.mode.kind}
          mode={dialog.mode}
          members={members}
          memberName={memberName}
          onClose={() => setDialog(null)}
          onSaved={(message, created) => {
            setDialog(null);
            toast.success(message);
            // 新建二级后展开它的一级，看得到排在 Other 前面
            if (dialog.mode.kind === 'create-child') toggle(dialog.mode.top.id, true);
            if (dialog.mode.kind === 'create-top' && created) toggle(created, true);
          }}
        />
      )}
      {dialog?.name === 'archive' && (
        <ArchiveCategoryDialog
          item={dialog.item}
          top={dialog.top}
          onClose={() => setDialog(null)}
          onArchived={(message) => {
            setDialog(null);
            toast.success(message);
          }}
        />
      )}
    </>
  );
}

type RowActions = {
  onEdit: (item: AdminCategoryItem, top: AdminTopCategory | null) => void;
  onAddChild: (top: AdminTopCategory) => void;
  onArchive: (item: AdminCategoryItem, top: AdminTopCategory | null) => void;
  onUnarchive: (item: AdminCategoryItem) => void;
  busy: boolean;
};

function Group({
  title,
  tops,
  showArchived,
  open,
  onToggle,
  memberName,
  actions,
}: {
  title: string;
  tops: AdminTopCategory[];
  showArchived: boolean;
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
  memberName: (id: string | null) => string | null;
  actions: RowActions;
}) {
  const visible = tops.filter((t) => showArchived || !t.isArchived);
  const childCount = visible.reduce(
    (n, t) => n + t.children.filter((c) => showArchived || !c.isArchived).length,
    0,
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-sm text-muted-foreground">
          {visible.length} 个一级 · {childCount} 个二级
        </span>
      </div>

      <div className="rounded-lg border bg-card">
        <div
          className={cn('hidden gap-3 border-b px-3 py-2 text-xs text-muted-foreground', ROW_GRID)}
        >
          <span className="pl-8">分类</span>
          <span>默认归属人</span>
          <span className="text-right">用了几笔</span>
          <span className="text-right">规则</span>
          <span className="sr-only">操作</span>
        </div>

        {visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">没有{title}分类</p>
        ) : (
          <ul className="divide-y">
            {visible.map((top) => {
              const expanded = open.has(top.id);
              const children = top.children.filter((c) => showArchived || !c.isArchived);
              return (
                <li key={top.id}>
                  <Row
                    item={top}
                    top={null}
                    expanded={expanded}
                    onToggle={() => onToggle(top.id)}
                    memberText={memberName(top.defaultMemberId) ?? '无'}
                    actions={actions}
                  />
                  {expanded && (
                    <ul className="divide-y border-t bg-muted/30">
                      {children.map((c) => {
                        const own = memberName(c.defaultMemberId);
                        const inherited = memberName(top.defaultMemberId);
                        return (
                          <li key={c.id}>
                            <Row
                              item={c}
                              top={top}
                              memberText={
                                own ?? (inherited ? `继承一级（${inherited}）` : '继承一级（无）')
                              }
                              actions={actions}
                            />
                          </li>
                        );
                      })}
                      {!top.isArchived && (
                        <li className="px-3 py-1.5 pl-11">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="-ml-2 text-muted-foreground"
                            onClick={() => actions.onAddChild(top)}
                          >
                            <Plus />
                            添加二级分类
                          </Button>
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function Row({
  item,
  top,
  expanded,
  onToggle,
  memberText,
  actions,
}: {
  item: AdminCategoryItem;
  top: AdminTopCategory | null; // null = 这一行是一级
  expanded?: boolean;
  onToggle?: () => void;
  memberText: string;
  actions: RowActions;
}) {
  // 一级归档了，二级也算归档（R16.3），一起灰
  const archived = item.isArchived || (top?.isArchived ?? false);
  const splits = `${item.splitCount} 笔`;
  const rules = `${item.ruleCount} 条规则`;

  return (
    <div className={cn('flex items-center gap-2 px-3 py-2 md:gap-3', ROW_GRID)}>
      <div className={cn('flex min-w-0 flex-1 items-center gap-2', archived && 'opacity-60')}>
        {top === null ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            aria-label={expanded ? `收起 ${item.nameEn}` : `展开 ${item.nameEn}`}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            <ChevronRight className={cn('transition-transform', expanded && 'rotate-90')} />
          </Button>
        ) : (
          <span aria-hidden className="w-6 shrink-0" />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <CategoryTag category={tagRef(item, top)} />
            {top !== null && item.isPreTaxDefault && (
              <Badge variant="secondary" className="font-normal">
                税前
              </Badge>
            )}
            {archived && (
              <Badge variant="outline" className="font-normal">
                已归档
              </Badge>
            )}
          </div>
          {/* 手机上的列挪到这一行 */}
          <span className="text-xs text-muted-foreground md:hidden">
            {memberText} · {splits} · {rules}
          </span>
        </div>
      </div>
      <span
        className={cn(
          'hidden truncate text-sm text-muted-foreground md:block',
          archived && 'opacity-60',
        )}
        title={memberText}
      >
        {memberText}
      </span>
      <span
        className={cn('hidden text-right text-sm tabular-nums md:block', archived && 'opacity-60')}
      >
        {splits}
      </span>
      <span
        className={cn(
          'hidden text-right text-sm text-muted-foreground tabular-nums md:block',
          archived && 'opacity-60',
        )}
      >
        {rules}
      </span>
      <RowMenu item={item} top={top} archived={archived} actions={actions} />
    </div>
  );
}

// R19.3、R19.4：Other 能改（归属人、税前），不能单独归档
function RowMenu({
  item,
  top,
  archived,
  actions,
}: {
  item: AdminCategoryItem;
  top: AdminTopCategory | null;
  archived: boolean;
  actions: RowActions;
}) {
  // 一级归档中的二级：先取消归档一级（R19.4），这里不给操作
  const parentArchived = top?.isArchived ?? false;
  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`${item.nameEn} 的操作`}
            disabled={actions.busy || parentArchived}
            title={parentArchived ? '一级在归档中，先取消归档一级' : undefined}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {archived ? (
            <DropdownMenuItem onSelect={() => actions.onUnarchive(item)}>
              <ArchiveRestore />
              取消归档
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => actions.onEdit(item, top)}>
                <Pencil />
                修改
              </DropdownMenuItem>
              {top === null && (
                <DropdownMenuItem onSelect={() => actions.onAddChild(item as AdminTopCategory)}>
                  <Plus />
                  添加二级分类
                </DropdownMenuItem>
              )}
              {!item.isOther && (
                <DropdownMenuItem onSelect={() => actions.onArchive(item, top)}>
                  <Archive />
                  归档
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// 系统分类：只列名字和笔数，灰色虚线框 tag（design/README 第 4 节 13）
function SystemGroup({ tops }: { tops: AdminTopCategory[] }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Lock className="size-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">系统分类</h2>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {tops.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2.5"
          >
            <CategoryTag category={tagRef(c, null)} />
            <span className="text-sm text-muted-foreground tabular-nums">{c.splitCount} 笔</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">系统分类不能修改。</p>
    </section>
  );
}
