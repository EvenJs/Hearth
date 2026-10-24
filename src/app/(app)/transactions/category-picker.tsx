'use client';

// 可折叠的分类下拉（2026-10-24）：一级是一组，点开看二级；顶部搜索框，打字自动展开命中的组
// 改分类（行内、批量、拆分对话框）和筛选栏共用。可选范围在 pickerSections 里定（R16.3）
// - mode = edit：组里第一项"X（不细分）"是一级本身
// - mode = filter：最上面"全部分类"（value = null），组里第一项"全部 X"包含它所有的二级
import { Check, ChevronRight, Search } from 'lucide-react';
import { useLayoutEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  searchPicker,
  type PickerGroup,
  type PickerSections,
} from '@/lib/transactions/category-picker';
import { cn } from '@/lib/utils';
import { ToneDot, toneOfTop } from './tx-badges';

type Props = {
  sections: PickerSections;
  value: string | null;
  onSelect: (id: string | null) => void;
  mode: 'edit' | 'filter';
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom';
  children: React.ReactNode; // 触发按钮（会被当成 asChild）
};

const itemClass =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden hover:bg-accent focus-visible:bg-accent';

function tone(g: PickerGroup) {
  return toneOfTop({ id: g.id, nameEn: g.name, kind: g.kind, systemKey: g.systemKey });
}

// 显示用：value 对应的完整名字（Groceries / Supermarket），找不到返回 null
export function pickerLabel(sections: PickerSections, id: string | null): string | null {
  if (!id) return null;
  for (const g of [...sections.groups, ...sections.system]) {
    if (g.id === id) return g.name;
    const c = g.children.find((x) => x.id === id);
    if (c) return `${g.name} / ${c.name}`;
  }
  return null;
}

export function CategoryPicker({
  sections,
  value,
  onSelect,
  mode,
  disabled,
  align = 'start',
  side = 'bottom',
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // 没有搜索词时手动点开、收起的组；每次打开从"只展开当前选中的组"开始
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());

  // 下拉是一次性的：页面被 <Activity> 藏起来时关掉（docs/tech-stack.md 2 "页面状态"）
  useLayoutEffect(() => () => setOpen(false), []);

  const view = useMemo(() => searchPicker(sections, query, value), [sections, query, value]);
  const searching = query.trim() !== '';
  // 默认展开的（当前选中的组，或者搜索命中的组）再叠加手动点过的
  const isExpanded = (id: string) => view.expanded.includes(id) !== toggled.has(id);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setQuery('');
      setToggled(new Set());
    }
  }

  function choose(id: string | null) {
    setOpen(false);
    if (id !== value) onSelect(id);
  }

  function toggle(id: string) {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // 搜索框里按回车：选第一个命中的。只有二级命中时选第一个二级，一级名命中时选一级本身
  function chooseFirst() {
    const g = view.groups[0];
    if (g) {
      const topHit = g.name.toLowerCase().includes(query.trim().toLowerCase());
      choose(!topHit && g.children.length > 0 ? g.children[0].id : g.id);
    } else if (view.system[0]) {
      choose(view.system[0].id);
    }
  }

  const empty = view.groups.length === 0 && view.system.length === 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild disabled={disabled}>
        {children}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 p-1"
        // 点"已拆分"行里的下拉时，不让外层的行点击跳转
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative p-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            aria-label="搜索分类"
            placeholder="搜索分类"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setToggled(new Set());
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                chooseFirst();
              }
            }}
            className="h-8 pl-8"
          />
        </div>

        <div className="max-h-80 overflow-y-auto overscroll-contain p-1" role="listbox">
          {mode === 'filter' && !searching && (
            <Item selected={value === null} onClick={() => choose(null)}>
              全部分类
            </Item>
          )}

          {view.groups.map((g) => {
            const expanded = isExpanded(g.id);
            return (
              <div key={g.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => (g.children.length > 0 ? toggle(g.id) : choose(g.id))}
                  className={cn(itemClass, 'font-medium')}
                >
                  <ToneDot tone={tone(g)} />
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                  {(value === g.id || g.children.some((c) => c.id === value)) && !expanded && (
                    <Check className="size-4 text-muted-foreground" />
                  )}
                  <ChevronRight
                    className={cn(
                      'size-4 shrink-0 text-muted-foreground transition-transform',
                      expanded && 'rotate-90',
                    )}
                  />
                </button>
                {expanded && (
                  <div className="mb-1 ml-3 border-l pl-2">
                    <Item selected={value === g.id} onClick={() => choose(g.id)}>
                      {mode === 'filter' ? `全部 ${g.name}` : `${g.name}（不细分）`}
                    </Item>
                    {g.children.map((c) => (
                      <Item key={c.id} selected={value === c.id} onClick={() => choose(c.id)}>
                        {c.name}
                      </Item>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {view.system.length > 0 && (
            <>
              <div className="mt-1 border-t px-2 pt-2 pb-1 text-xs text-muted-foreground">系统</div>
              {view.system.map((s) => (
                <Item key={s.id} selected={value === s.id} onClick={() => choose(s.id)}>
                  <ToneDot tone={tone(s)} />
                  {s.name}
                </Item>
              ))}
            </>
          )}

          {empty && (
            <p className="px-2 py-4 text-center text-sm text-muted-foreground">没有这个分类</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Item({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(itemClass, selected && 'font-medium')}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      {selected && <Check className="size-4 shrink-0" />}
    </button>
  );
}
