import { Clock, Link2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { CategoryRef, SplitView, TransactionListItem } from '@/server/transactions';
import { categoryLabel } from './format';

// 流水里的标签（docs/design/README.md 第 3 节、R16.7）
// 未分类琥珀色、建议转账蓝色、pending 灰色带时钟；R6.2 只配对没改的交易显示"已配对，分类是手动的"

const base = 'border-transparent font-normal';

export function isUncategorized(s: SplitView): boolean {
  return s.category.systemKey === 'uncategorized';
}

export function UncategorizedBadge() {
  return <Badge className={cn(base, 'bg-amber-100 text-amber-800')}>未分类</Badge>;
}

// 分类 tag：颜色只分三种，按 R10 口径
// 支出灰色；收入浅绿；系统分类（内部转账、现金支出、银行费用）虚线边框；未分类琥珀色
function categoryTone(c: CategoryRef): string {
  if (c.kind === 'income') return 'bg-green-50 text-green-800';
  if (c.kind === 'system')
    return 'border-dashed border-border bg-transparent text-muted-foreground';
  return 'bg-muted text-foreground';
}

// 有二级只显示二级，没有就显示一级；鼠标悬停看完整路径（比如 Personal & medical / Other）
export function CategoryTag({ category }: { category: CategoryRef }) {
  if (category.systemKey === 'uncategorized') return <UncategorizedBadge />;
  return (
    <Badge
      title={categoryLabel(category)}
      className={cn(base, 'max-w-full', categoryTone(category))}
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
