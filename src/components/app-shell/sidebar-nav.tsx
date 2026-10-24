'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { isActive, NAV_ITEMS, type NavItem, type NavLeaf } from './nav';

const itemClass = 'flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors';
const activeClass = 'bg-primary font-medium text-primary-foreground';
const idleClass = 'text-foreground/80 hover:bg-primary/10 hover:text-foreground';
const disabledClass = 'cursor-not-allowed text-muted-foreground/60';

// onNavigate：手机 Sheet 里点了链接后关掉 Sheet
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  function leaf(item: NavLeaf, className: string, children: React.ReactNode) {
    if (item.href === null) {
      return (
        <span aria-disabled="true" title="还没做" className={cn(className, disabledClass)}>
          {children}
        </span>
      );
    }
    const active = isActive(item.href, pathname);
    return (
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
        className={cn(className, active ? activeClass : idleClass)}
      >
        {children}
      </Link>
    );
  }

  return (
    <nav aria-label="主导航">
      <ul className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const label = (
            <>
              <Icon className="size-4 shrink-0" />
              {item.label}
            </>
          );
          return (
            <li key={item.label}>
              {item.children ? (
                <NavGroup item={item} label={label} pathname={pathname} leaf={leaf} />
              ) : (
                leaf(item, itemClass, label)
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// 有子项的分组（设置）：标题是展开收起按钮。当前页在分组里时默认展开，否则收起
function NavGroup({
  item,
  label,
  pathname,
  leaf,
}: {
  item: NavItem;
  label: React.ReactNode;
  pathname: string;
  leaf: (item: NavLeaf, className: string, children: React.ReactNode) => React.ReactNode;
}) {
  const children = item.children ?? [];
  const [open, setOpen] = useState(() => children.some((c) => isActive(c.href, pathname)));
  const listId = `nav-group-${item.label}`;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className={cn(itemClass, idleClass, 'w-full')}
      >
        {label}
        <ChevronDown
          className={cn('ml-auto size-4 transition-transform', open ? 'rotate-180' : '')}
        />
      </button>
      {open && (
        <ul id={listId} className="mt-1 flex flex-col gap-1 pl-7">
          {children.map((child) => (
            <li key={child.label}>{leaf(child, cn(itemClass, 'h-8'), child.label)}</li>
          ))}
        </ul>
      )}
    </>
  );
}
