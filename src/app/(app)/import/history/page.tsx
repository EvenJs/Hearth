import { CheckCircle2, ChevronLeft, CircleSlash, FileUp, XCircle } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { BANK_LABELS } from '@/lib/accounts/account-input';
import { statementPeriod } from '@/lib/import/anz-statement';
import { formatAud } from '@/lib/rules/money';
import type { Reconciliation } from '@/lib/rules/reconcile';
import { getHouseholdContext } from '@/server/context';
import { listImportHistory, type ImportHistoryRow } from '@/server/imports';
import { UndoImportButton } from '../undo-import-button';

// F2 导入历史（设计图 08）。R12.1：每个账户只有最近一次导入能撤销
export default function ImportHistoryPage() {
  return (
    <>
      <Link
        href="/import"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        导入
      </Link>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">导入历史</h1>
          <p className="text-sm text-muted-foreground">
            每个账户只能撤销最近一次导入。更早的导入和后面的日期重叠，撤销会让那段数据变空。
          </p>
        </div>
        <Button asChild size="sm" className="w-fit shrink-0">
          <Link href="/import">
            <FileUp className="size-4" />
            新导入
          </Link>
        </Button>
      </header>

      {/* 读 session 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <HistorySection />
      </Suspense>
    </>
  );
}

const createdAtFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Australia/Melbourne',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

async function HistorySection() {
  const ctx = await getHouseholdContext();
  const rows = await listImportHistory(ctx);

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        还没有导入过。去{' '}
        <Link href="/import" className="text-primary underline underline-offset-4">
          导入页
        </Link>{' '}
        上传第一个 CSV。
      </p>
    );
  }

  return (
    // 按内容区自己的宽度切换（container query），不按窗口宽度：侧边栏会占掉 250px 左右
    // 内容区 < 56rem（896px）：卡片列表，设计图 08-mobile；否则表格
    <div className="@container">
      <ul className="flex flex-col gap-3 @4xl:hidden">
        {rows.map((r) => (
          <HistoryCard key={r.batchId} r={r} />
        ))}
      </ul>

      <Card className="hidden py-0 @4xl:flex">
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">账户</TableHead>
                <TableHead>文件</TableHead>
                <TableHead>日期范围</TableHead>
                <TableHead className="text-right">新增</TableHead>
                <TableHead className="text-right">跳过</TableHead>
                <TableHead className="text-right" title="确认的手动录入（pending）">
                  确认
                </TableHead>
                <TableHead>对账</TableHead>
                <TableHead className="pr-4">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <HistoryRow key={r.batchId} r={r} />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// CSV 显示文件里的日期范围；对账单显示纸面上的账期（R1C）
function DateRange({ r }: { r: ImportHistoryRow }) {
  if (r.source === 'pdf') {
    const p = statementPeriod(r.dateFrom, r.dateTo);
    return (
      <>
        账期 {p.from} 至 {p.to}
      </>
    );
  }
  return (
    <>
      {r.dateFrom} 至 {r.dateTo}
    </>
  );
}

function SourceBadge({ source }: { source: ImportHistoryRow['source'] }) {
  return (
    <Badge variant="outline" className="shrink-0">
      {source === 'pdf' ? '对账单' : 'CSV'}
    </Badge>
  );
}

// "CBA · CBA" 这种账户名已经带银行名的，不再重复显示银行
function AccountLabel({ account }: { account: ImportHistoryRow['account'] }) {
  const bank = BANK_LABELS[account.bank];
  const showBank = !account.name.toLowerCase().includes(bank.toLowerCase());
  return (
    <>
      {showBank && `${bank} · `}
      {account.name}
      {account.numberSuffix && (
        <span className="text-muted-foreground"> ••{account.numberSuffix}</span>
      )}
    </>
  );
}

function HistoryCard({ r }: { r: ImportHistoryRow }) {
  return (
    <li>
      <Card className="gap-3 py-4">
        <CardContent className="flex flex-col gap-2 px-4 text-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 text-base font-medium break-words">
              <AccountLabel account={r.account} />
            </span>
            {r.canUndo && <UndoImportButton batchId={r.batchId} after="history" />}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <SourceBadge source={r.source} />
            <Link
              href={`/import/${r.batchId}`}
              className="min-w-0 break-all text-primary underline-offset-4 hover:underline"
            >
              {r.fileName}
            </Link>
            <span className="text-muted-foreground tabular-nums">
              导入于 {createdAtFormat.format(r.createdAt)}
            </span>
          </div>
          <span className="text-muted-foreground tabular-nums">
            <DateRange r={r} />
          </span>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pt-1">
            <span className="tabular-nums">
              新增 {r.insertedCount} · 跳过 {r.duplicateCount} · 确认 pending{' '}
              {r.matchedPendingCount}
            </span>
            <ReconciliationCell rec={r.reconciliation} />
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

function HistoryRow({ r }: { r: ImportHistoryRow }) {
  return (
    <TableRow>
      <TableCell className="pl-4">
        <AccountLabel account={r.account} />
      </TableCell>
      {/* 导入时间是辅助信息，放文件名下面，不单独占一列 */}
      <TableCell className="max-w-60">
        <div className="flex min-w-0 items-center gap-2">
          <SourceBadge source={r.source} />
          <Link
            href={`/import/${r.batchId}`}
            title={r.fileName}
            className="block min-w-0 truncate text-primary underline-offset-4 hover:underline"
          >
            {r.fileName}
          </Link>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {createdAtFormat.format(r.createdAt)}
        </span>
      </TableCell>
      <TableCell className="tabular-nums">
        <DateRange r={r} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{r.insertedCount}</TableCell>
      <TableCell className="text-right tabular-nums">{r.duplicateCount}</TableCell>
      <TableCell className="text-right tabular-nums">{r.matchedPendingCount}</TableCell>
      <TableCell>
        <ReconciliationCell rec={r.reconciliation} />
      </TableCell>
      <TableCell className="pr-4 text-right">
        {r.canUndo && <UndoImportButton batchId={r.batchId} after="history" />}
      </TableCell>
    </TableRow>
  );
}

function ReconciliationCell({ rec }: { rec: Reconciliation }) {
  if (rec.status === 'none') {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <CircleSlash className="size-4" />
        没有余额
      </span>
    );
  }
  if (rec.status === 'passed') {
    return (
      <span className="flex items-center gap-1.5 text-green-700">
        <CheckCircle2 className="size-4" />
        通过
      </span>
    );
  }
  const diff = rec.differenceCents;
  return (
    <span className="flex items-center gap-1.5 text-destructive">
      <XCircle className="size-4" />
      差额 {diff > 0 ? '+' : ''}
      {formatAud(diff)}
    </span>
  );
}
