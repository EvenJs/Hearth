'use client';

// 设置 → 规则的列表（设计图 12，R18.1）。电脑上表格，手机上卡片（12-settings-rules-mobile）
// 搜索和一级筛选写在 URL 上（?q=、?category=），服务端用 filterRules 筛好传进来
// 新建、修改、删除之后问"要对 N 笔应用吗"（R18.4、R7.2），N = 0 只给 toast
import { MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { PickerSections } from '@/lib/transactions/category-picker';
import type { RuleListItem } from '@/server/rules';
import type { CategoryRef } from '@/server/transactions';
import { previewReapplyAction } from '../../transactions/actions';
import { transactionsHref } from '../../transactions/href';
import { CategoryTag } from '../../transactions/tx-badges';
import { ApplyRulesDialog, DeleteRuleDialog, type ApplyPreview } from './confirm-dialogs';
import { MATCH_TYPE_LABEL, RuleDialog } from './rule-dialog';

export type CategoryRefMap = Record<string, CategoryRef>;
export type TopOption = { id: string; name: string };

type Props = {
  rules: RuleListItem[]; // 已经按 q、category 筛好、按关键词排好
  totalCount: number; // 不筛选时的总数
  q: string;
  category: string; // 一级 id，'' = 全部
  tops: TopOption[];
  refs: CategoryRefMap;
  sections: PickerSections; // 分类下拉（R16.3）
};

type Dialog =
  | { name: 'create' }
  | { name: 'edit'; rule: RuleListItem }
  | { name: 'delete'; rule: RuleListItem }
  | { name: 'apply'; preview: ApplyPreview };

const ALL = '__all';
const SEARCH_DELAY_MS = 300;
const HITS_NOTE = 'F8 按商家搜索，笔数可能更多';

function rulesHref(q: string, category: string): string {
  const p = new URLSearchParams();
  if (q.trim()) p.set('q', q.trim());
  if (category) p.set('category', category);
  const qs = p.toString();
  return qs ? `/settings/rules?${qs}` : '/settings/rules';
}

export function RulesView({ rules, totalCount, q, category, tops, refs, sections }: Props) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [, startTransition] = useTransition();

  // 对话框是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(() => () => setDialog(null), []);

  // 搜索框：本地 state，停手 300ms 后写进 URL。URL 从外面变了（点链接进来）时跟上
  const [text, setText] = useState(q);
  const [prevQ, setPrevQ] = useState(q);
  if (q !== prevQ) {
    setPrevQ(q);
    if (q !== text.trim()) setText(q);
  }
  useEffect(() => {
    if (text.trim() === q) return;
    const timer = setTimeout(() => {
      startTransition(() => router.replace(rulesHref(text, category), { scroll: false }));
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, q, category, router]);

  function setCategory(value: string) {
    const next = value === ALL ? '' : value;
    startTransition(() => router.replace(rulesHref(text, next), { scroll: false }));
  }

  // 新建、修改、删除成功后：R7.2 预览，N = 0 只给 toast，否则问要不要应用
  async function afterWrite(savedMessage: string) {
    setDialog(null);
    const p = await previewReapplyAction();
    if (!p.ok) {
      toast.error(p.message);
      return;
    }
    if (p.changeCount === 0) {
      toast.success(`${savedMessage}，没有需要重新分类的交易`);
      return;
    }
    toast.success(savedMessage);
    setDialog({
      name: 'apply',
      preview: { changeCount: p.changeCount, skippedCount: p.skippedCount },
    });
  }

  const filtered = q !== '' || category !== '';
  // URL 里的一级不在选项里（归档了或者不存在）时，下拉里也显示出来，免得看起来没筛选
  const unknownTop = category !== '' && !tops.some((t) => t.id === category);

  return (
    <>
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative md:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="搜索关键词"
            placeholder="搜索关键词"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={category || ALL} onValueChange={setCategory}>
          <SelectTrigger aria-label="按一级分类筛选" className="w-full md:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部分类</SelectItem>
            {unknownTop && <SelectItem value={category}>（已归档的分类）</SelectItem>}
            {tops.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button className="md:ml-auto" onClick={() => setDialog({ name: 'create' })}>
          <Plus />
          新建规则
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        {filtered ? `${rules.length} / ${totalCount} 条规则` : `共 ${totalCount} 条规则`}
      </p>

      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {filtered ? (
            <>
              没有符合条件的规则。
              <Link href="/settings/rules" className="ml-1 underline underline-offset-4">
                清除筛选
              </Link>
            </>
          ) : (
            '还没有规则。在流水里改分类时可以存成规则，也可以在这里新建。'
          )}
        </div>
      ) : (
        <>
          {/* 电脑：表格 */}
          <div className="hidden rounded-lg border md:block">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>关键词</TableHead>
                  <TableHead className="w-24">匹配方式</TableHead>
                  <TableHead className="w-72">分类</TableHead>
                  <TableHead className="w-24 text-right">命中</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Keyword rule={r} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {MATCH_TYPE_LABEL[r.matchType]}
                    </TableCell>
                    <TableCell>
                      <RuleCategory rule={r} refs={refs} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Hits rule={r} />
                    </TableCell>
                    <TableCell>
                      <RowMenu rule={r} onAction={setDialog} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* 手机：卡片 */}
          <ul className="flex flex-col gap-2 md:hidden">
            {rules.map((r) => (
              <li key={r.id} className="flex items-start gap-2 rounded-lg border bg-card p-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Keyword rule={r} />
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <RuleCategory rule={r} refs={refs} />
                    <span className="text-xs text-muted-foreground">
                      {MATCH_TYPE_LABEL[r.matchType]}
                    </span>
                  </div>
                </div>
                <div className="pt-0.5">
                  <Hits rule={r} />
                </div>
                <RowMenu rule={r} onAction={setDialog} />
              </li>
            ))}
          </ul>

          <p className="text-xs text-muted-foreground">
            命中：现在重新分类时会用到这条规则的笔数，内部转账和 ATM
            取现、账户费不算。“包含”规则的数字可以点，去流水按商家搜索，那边的笔数可能更多（被更长关键词抢走的、转账、系统规则的也会列出来）。
          </p>
        </>
      )}

      {(dialog?.name === 'create' || dialog?.name === 'edit') && (
        <RuleDialog
          key={dialog.name === 'edit' ? dialog.rule.id : 'create'}
          rule={dialog.name === 'edit' ? dialog.rule : null}
          sections={sections}
          onClose={() => setDialog(null)}
          onSaved={(msg) => void afterWrite(msg)}
        />
      )}
      {dialog?.name === 'delete' && (
        <DeleteRuleDialog
          rule={dialog.rule}
          onClose={() => setDialog(null)}
          onDeleted={() => void afterWrite('规则已删除')}
        />
      )}
      {dialog?.name === 'apply' && (
        <ApplyRulesDialog preview={dialog.preview} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function Keyword({ rule }: { rule: RuleListItem }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span title={rule.keyword} className="truncate font-mono font-medium">
        {rule.keyword}
      </span>
      {rule.isSystem && (
        <Badge variant="secondary" className="shrink-0 font-normal">
          预置
        </Badge>
      )}
    </span>
  );
}

// 分类 tag（design/README 第 3 节颜色）。指向已归档分类的规则只显示名字
function RuleCategory({ rule, refs }: { rule: RuleListItem; refs: CategoryRefMap }) {
  const ref = refs[rule.categoryId];
  if (ref) return <CategoryTag category={ref} />;
  return (
    <Badge variant="outline" className="max-w-full font-normal text-muted-foreground">
      <span className="truncate">{rule.categoryLabel}（已归档）</span>
    </Badge>
  );
}

// R18.1：包含的能点，跳 F8 带商家筛选；开头是的不能点（F8 没有开头匹配，数字会对不上）
function Hits({ rule }: { rule: RuleListItem }) {
  const text = `${rule.hits} 笔`;
  if (rule.matchType === 'contains') {
    return (
      <Link
        href={transactionsHref({ merchant: rule.keyword })}
        title={HITS_NOTE}
        className="whitespace-nowrap tabular-nums underline-offset-4 hover:underline"
      >
        {text}
      </Link>
    );
  }
  return (
    <span
      title="流水只能按包含搜索，开头是的规则不能跳过去"
      className="whitespace-nowrap text-muted-foreground tabular-nums"
    >
      {text}
    </span>
  );
}

function RowMenu({ rule, onAction }: { rule: RuleListItem; onAction: (d: Dialog) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`${rule.keyword} 的操作`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAction({ name: 'edit', rule })}>
          <Pencil />
          修改
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => onAction({ name: 'delete', rule })}>
          <Trash2 />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
