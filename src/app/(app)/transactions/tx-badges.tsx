import { Clock, Link2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { categoryColor, type CategoryTone } from '@/lib/transactions/category-color';
import { cn } from '@/lib/utils';
import type { CategoryRef, SplitView, TransactionListItem } from '@/server/transactions';
import { categoryLabel } from './format';

// 流水里的标签（docs/design/README.md 第 3 节、R16.7）
// 未分类琥珀色、建议转账蓝色、pending 灰色带时钟、可能重复玫红（duplicate-badge.tsx）；R6.2 只配对没改的交易显示"已配对，分类是手动的"

const base = 'border-transparent font-normal';

// R17.6 可能重复（M6-6）：玫红，和未分类、建议转账、待确认、分类色系都不撞
export const DUPLICATE_TONE = 'bg-rose-100 text-rose-800';

export function isUncategorized(s: SplitView): boolean {
  return s.category.systemKey === 'uncategorized';
}

export function UncategorizedBadge() {
  return <Badge className={cn(base, 'bg-amber-100 text-amber-800')}>未分类</Badge>;
}

// 分类 tag 的颜色（design/README 第 3 节）：每个一级一个色系（src/lib/transactions/category-color.ts）
// 一级本身是深一点的实心色（300）；二级用所属一级的色系，浅底（100）加边框
// 未分类琥珀色；系统分类（内部转账、现金支出、银行费用）虚线边框
// Tailwind 只认完整的 class 名，所以每个颜色都写全
const TONES: Record<CategoryTone, { strong: string; soft: string; dot: string }> = {
  orange: {
    strong: 'bg-orange-300 text-orange-950',
    soft: 'border-orange-300 bg-orange-100 text-orange-800',
    dot: 'bg-orange-500',
  },
  indigo: {
    strong: 'bg-indigo-300 text-indigo-950',
    soft: 'border-indigo-300 bg-indigo-100 text-indigo-800',
    dot: 'bg-indigo-500',
  },
  teal: {
    strong: 'bg-teal-300 text-teal-950',
    soft: 'border-teal-300 bg-teal-100 text-teal-800',
    dot: 'bg-teal-500',
  },
  pink: {
    strong: 'bg-pink-300 text-pink-950',
    soft: 'border-pink-300 bg-pink-100 text-pink-800',
    dot: 'bg-pink-500',
  },
  violet: {
    strong: 'bg-violet-300 text-violet-950',
    soft: 'border-violet-300 bg-violet-100 text-violet-800',
    dot: 'bg-violet-500',
  },
  lime: {
    strong: 'bg-lime-300 text-lime-950',
    soft: 'border-lime-400 bg-lime-100 text-lime-800',
    dot: 'bg-lime-500',
  },
  green: {
    strong: 'bg-green-300 text-green-950',
    soft: 'border-green-300 bg-green-100 text-green-800',
    dot: 'bg-green-500',
  },
  rose: {
    strong: 'bg-rose-300 text-rose-950',
    soft: 'border-rose-300 bg-rose-100 text-rose-800',
    dot: 'bg-rose-500',
  },
  cyan: {
    strong: 'bg-cyan-300 text-cyan-950',
    soft: 'border-cyan-300 bg-cyan-100 text-cyan-800',
    dot: 'bg-cyan-500',
  },
  fuchsia: {
    strong: 'bg-fuchsia-300 text-fuchsia-950',
    soft: 'border-fuchsia-300 bg-fuchsia-100 text-fuchsia-800',
    dot: 'bg-fuchsia-500',
  },
  emerald: {
    strong: 'bg-emerald-300 text-emerald-950',
    soft: 'border-emerald-300 bg-emerald-100 text-emerald-800',
    dot: 'bg-emerald-500',
  },
  uncategorized: {
    strong: 'bg-amber-100 text-amber-800',
    soft: 'bg-amber-100 text-amber-800',
    dot: 'bg-amber-500',
  },
  system: {
    strong: 'border-dashed border-border bg-transparent text-muted-foreground',
    soft: 'border-dashed border-border bg-transparent text-muted-foreground',
    dot: 'border border-dashed border-muted-foreground bg-transparent',
  },
};

// 一级的色系
export function toneOfTop(top: {
  id: string;
  nameEn: string;
  kind: CategoryRef['kind'];
  systemKey: string | null;
}): CategoryTone {
  return categoryColor({
    topId: top.id,
    topName: top.nameEn,
    kind: top.kind,
    systemKey: top.systemKey,
  });
}

function toneOf(c: CategoryRef): CategoryTone {
  return c.parent
    ? toneOfTop({ id: c.parent.id, nameEn: c.parent.nameEn, kind: c.kind, systemKey: null })
    : toneOfTop(c);
}

// 看板分类占比的进度条（M5-4）：用色点的颜色；系统分类的虚线框画不成条，用实心灰
export function toneBarClass(tone: CategoryTone): string {
  return tone === 'system' ? 'bg-muted-foreground/40' : TONES[tone].dot;
}

// 下拉里一级名前面的色点
export function ToneDot({ tone, className }: { tone: CategoryTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2.5 shrink-0 rounded-full', TONES[tone].dot, className)}
    />
  );
}

// 有二级只显示二级，没有就显示一级；鼠标悬停看完整路径（比如 Personal & medical / Other）
export function CategoryTag({ category }: { category: CategoryRef }) {
  if (category.systemKey === 'uncategorized') return <UncategorizedBadge />;
  const tone = TONES[toneOf(category)];
  return (
    <Badge
      title={categoryLabel(category)}
      className={cn(base, 'max-w-full', category.parent ? tone.soft : tone.strong)}
    >
      <span className="truncate">{category.nameEn}</span>
    </Badge>
  );
}

// 交易本身的标签。未分类是拆分上的，由调用的地方按拆分显示
export function TxBadges({ tx }: { tx: TransactionListItem }) {
  return (
    <>
      {tx.status === 'pending' && (
        <Badge className={cn(base, 'bg-muted text-muted-foreground')}>
          <Clock />
          待确认
        </Badge>
      )}
      {tx.transferStatus === 'suggested' && (
        <Badge className={cn(base, 'bg-blue-100 text-blue-800')}>建议转账</Badge>
      )}
      {/* R16.7：有配对但 transfer_status = none */}
      {tx.transferPairId !== null && tx.transferStatus === 'none' && (
        <Badge className={cn(base, 'bg-secondary text-secondary-foreground')}>
          <Link2 />
          已配对，分类是手动的
        </Badge>
      )}
    </>
  );
}
