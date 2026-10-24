// 侧边栏导航（docs/design/README.md 第 3 节）。电脑侧边栏和手机 Sheet 共用
// href 为 null：页面还没做，显示为不可点。做完对应任务时填上 href
import { FileUp, LayoutDashboard, ReceiptText, Settings, type LucideIcon } from 'lucide-react';

export type NavLeaf = { label: string; href: string | null };
export type NavItem = NavLeaf & { icon: LucideIcon; children?: NavLeaf[] };

export const NAV_ITEMS: NavItem[] = [
  { label: '看板', href: '/', icon: LayoutDashboard },
  { label: '流水', href: null, icon: ReceiptText }, // M4
  {
    label: '导入',
    href: null,
    icon: FileUp,
    children: [
      { label: '上传 CSV', href: '/import' },
      { label: '导入历史', href: '/import/history' },
    ],
  },
  {
    label: '设置',
    href: null,
    icon: Settings,
    children: [
      { label: '账户', href: '/settings/accounts' },
      { label: '预算', href: null },
      { label: '税务', href: null },
    ],
  },
];

// 看板只在 / 高亮；其他按前缀匹配（/import/history 也高亮"导入"）
export function isActive(href: string | null, pathname: string): boolean {
  if (href === null) return false;
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

// 分组里只高亮一项：匹配的 href 里最长的那个。
// /import/history 只亮"导入历史"；/import/[batchId] 亮"上传 CSV"
export function activeChildHref(children: NavLeaf[], pathname: string): string | null {
  let best: string | null = null;
  for (const c of children) {
    if (c.href !== null && isActive(c.href, pathname) && c.href.length > (best?.length ?? -1)) {
      best = c.href;
    }
  }
  return best;
}
