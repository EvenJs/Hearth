import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// 各页 Suspense 的 fallback（M13-3）：照真实布局的网格摆占位，切页时先出骨架。
// 页面自己的 header（标题、说明）在 Suspense 外面，这里只画 Suspense 里面那部分；看板例外，标题在 Suspense 里

// 带标题的卡片，内容是若干行
function CardBlock({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <Skeleton className="h-5 w-32" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

// 表头 + rows 行，外面套卡片（流水、设置、导入共用）
function TableBlock({ rows }: { rows: number }) {
  return (
    <Card className="gap-0 py-0">
      <div className="border-b px-4 py-3">
        <Skeleton className="h-4 w-1/2" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
          <Skeleton className="h-4 w-20 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16 shrink-0" />
        </div>
      ))}
    </Card>
  );
}

// 看板：标题行 + KPI 四格 + 支出分类 / Top 商家两块
export function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="加载看板" className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-x-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold">看板</h1>
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-9 w-40" />
        </div>
      </header>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="gap-3 p-4">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-7 w-24" />
          </Card>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-3 lg:gap-4">
        <CardBlock lines={6} className="lg:col-span-2" />
        <CardBlock lines={6} />
      </div>
    </div>
  );
}

// 流水：筛选栏 + 表头 + 8 行
export function TransactionsSkeleton() {
  return (
    <div aria-busy="true" aria-label="加载流水" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
      <TableBlock rows={8} />
    </div>
  );
}

// 账户总览：卡片网格
export function AccountsSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="加载账户"
      className="grid gap-3 sm:grid-cols-2 lg:gap-4 xl:grid-cols-3"
    >
      {Array.from({ length: 6 }, (_, i) => (
        <CardBlock key={i} lines={3} />
      ))}
    </div>
  );
}

// 目标：两张卡片
export function GoalsSkeleton() {
  return (
    <div aria-busy="true" aria-label="加载目标" className="grid gap-3 lg:grid-cols-2 lg:gap-4">
      <CardBlock lines={4} />
      <CardBlock lines={4} />
    </div>
  );
}

// 交易详情：标题 + 两块卡片
export function TransactionDetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="加载交易" className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-40" />
      </header>
      <CardBlock lines={4} />
      <CardBlock lines={3} />
    </div>
  );
}

// 设置页、导入页共用：一条工具栏 + 表格
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="正在加载"className="flex flex-col gap-4">
      <Skeleton className="h-9 w-full max-w-sm" />
      <TableBlock rows={rows} />
    </div>
  );
}
