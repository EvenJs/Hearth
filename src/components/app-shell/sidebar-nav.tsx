'use client';

import { ChevronDown, Loader2, type LucideIcon } from 'lucide-react';
import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { activeChildHref, isActive, NAV_ITEMS, type NavItem, type NavLeaf } from './nav';

const itemClass = 'flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors';
const activeClass = 'bg-primary font-medium text-primary-foreground';
const idleClass = 'text-foreground/80 hover:bg-primary/10 hover:text-foreground';
const disabledClass = 'cursor-not-allowed text-muted-foreground/60';

// 手机 Sheet：点当前页的链接时关掉 Sheet。去别的页面不在这里关，等路径变了再关（MobileNav），
// 这样页面出来之前菜单里能看到转圈（M13-3）
type NavProps = { onNavigate?: () => void };

// usePathname 在动态路由（/import/[batchId]）上只有请求时才知道，cacheComponents 要求放进 Suspense。
// 用的地方：<Suspense fallback={<SidebarNavFallback />}><SidebarNav /></Suspense>
export function SidebarNav(props: NavProps) {
  return <NavList pathname={usePathname()} {...props} />;
}

// 还没拿到路径时：同样的导航，不高亮，链接照样能点
export function SidebarNavFallback(props: NavProps) {
  return <NavList pathname={null} {...props} />;
}

function NavList({ pathname, onNavigate }: NavProps & { pathname: string | null }) {
  // active 不传时按 isActive 判断；分组里由 NavGroup 传入（同组只高亮一项）
  function leaf(item: NavLeaf, className: string, icon?: LucideIcon, activeOverride?: boolean) {
    if (item.href === null) {
      return (
        <span aria-disabled="true" title="还没做" className={cn(className, disabledClass)}>
          <NavLabel icon={icon} label={item.label} />
        </span>
      );
    }
    const active = activeOverride ?? (pathname !== null && isActive(item.href, pathname));
    return (
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        onClick={active ? onNavigate : undefined}
        className={cn(className, active ? activeClass : idleClass)}
      >
        <NavLinkLabel icon={icon} label={item.label} />
      </Link>
    );
  }

  return (
    <nav aria-label="主导航">
      <ul className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.label}>
            {item.children ? (
              <NavGroup item={item} pathname={pathname} leaf={leaf} />
            ) : (
              leaf(item, itemClass, item.icon)
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

// 有子项的分组（导入、设置）：标题是展开收起按钮。当前页在分组里时默认展开，否则收起
function NavGroup({
  item,
  pathname,
  leaf,
}: {
  item: NavItem;
  pathname: string | null;
  leaf: (
    item: NavLeaf,
    className: string,
    icon?: LucideIcon,
    activeOverride?: boolean,
  ) => React.ReactNode;
}) {
  const children = item.children ?? [];
  const activeHref = pathname === null ? null : activeChildHref(children, pathname);
  const [open, setOpen] = useState(() => activeHref !== null);
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
        <NavLabel icon={item.icon} label={item.label} />
        <ChevronDown
          className={cn('ml-auto size-4 transition-transform', open ? 'rotate-180' : '')}
        />
      </button>
      {open && (
        <ul id={listId} className="mt-1 flex flex-col gap-1 pl-7">
          {children.map((child) => (
            <li key={child.label}>
              {leaf(
                child,
                cn(itemClass, 'h-8'),
                undefined,
                pathname === null ? false : child.href !== null && child.href === activeHref,
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NavLabel({ icon: Icon, label }: { icon?: LucideIcon; label: string }) {
  return (
    <>
      {Icon && <Icon className="size-4 shrink-0" />}
      {label}
    </>
  );
}

// M13-3：点下去到新页面出来之前转圈。useLinkStatus 只能用在 <Link> 里面。
// 一级项把图标换成转圈；子项没有图标，转圈放在文字右边，平时透明占位，不让文字跳
function NavLinkLabel({ icon: Icon, label }: { icon?: LucideIcon; label: string }) {
  const { pending } = useLinkStatus();
  if (Icon) {
    return (
      <>
        {pending ? (
          <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
        ) : (
          <Icon className="size-4 shrink-0" />
        )}
        {label}
      </>
    );
  }
  return (
    <>
      {label}
      <Loader2
        aria-hidden
        className={cn('ml-auto size-3.5 shrink-0 animate-spin', pending ? '' : 'opacity-0')}
      />
    </>
  );
}
