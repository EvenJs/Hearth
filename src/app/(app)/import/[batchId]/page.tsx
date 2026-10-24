import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Clock,
  Copy,
  History,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { BANK_LABELS } from '@/lib/accounts/account-input';
import { formatAud } from '@/lib/rules/money';
import { cn } from '@/lib/utils';
import { getHouseholdContext } from '@/server/context';
import { getImportResult, type ImportResultView, type ResultTx } from '@/server/imports';
import { UndoImportButton } from '../undo-import-button';

// F2 导入结果（设计图 07）：R12 第 10 步的结果。撤销用导入历史页同一个按钮和弹窗
export default function ImportResultPage(props: PageProps<'/import/[batchId]'>) {
  return (
    <>
      <nav className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link
          href="/import"
          className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          导入
        </Link>
        <Link
          href="/import/history"
          className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <History className="size-4" />
          导入历史
        </Link>
      </nav>
      {/* 读 session 和 params 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <ResultSection params={props.params} />
      </Suspense>
    </>
  );
}

async function ResultSection({ params }: { params: PageProps<'/import/[batchId]'>['params'] }) {
  const { batchId } = await params;
  if (!z.uuid().safeParse(batchId).success) notFound();
  const ctx = await getHouseholdContext();
  const r = await getImportResult(ctx, batchId);
  if (!r) notFound();
  return <ImportResult r={r} />;
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

function ImportResult({ r }: { r: ImportResultView }) {
  const hasNotices =
    r.balanceWarnings.length > 0 || r.possibleDuplicates.length > 0 || r.pendingToCheck.length > 0;

  return (
    <>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl font-semibold">导入完成</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <Badge variant="secondary">
              {BANK_LABELS[r.account.bank]} · {r.account.name}
              {r.account.numberSuffix && ` ••${r.account.numberSuffix}`}
            </Badge>
            <span className="break-all">{r.fileName}</span>
            <span>
              {r.dateFrom} 至 {r.dateTo}
            </span>
            <span>导入于 {createdAtFormat.format(r.createdAt)}</span>
          </div>
        </div>
        {/* R12.1：只有该账户最近一次导入能撤销 */}
        {r.canUndo ? (
          <UndoImportButton batchId={r.batchId} after="result" label="撤销这次导入" />
        ) : (
          <Link
            href="/import/history"
            className="w-fit shrink-0 text-sm text-muted-foreground hover:text-foreground"
          >
            这个账户之后还有导入，不能撤销
          </Link>
        )}
      </header>

      {/* 计数 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="新增" value={r.insertedCount} hint={`文件共 ${r.rowCount} 行`} />
        <Stat label="跳过重复" value={r.duplicateCount} hint="以前导入过的" />
        <Stat label="确认手动录入" value={r.matchedPendingCount} hint="和待确认的交易匹配上" />
        <Stat
          label="未分类"
          value={r.uncategorizedCount}
          hint={r.uncategorizedCount > 0 ? '需要手动分类' : '都分好了'}
          warn={r.uncategorizedCount > 0}
          // M4-7：跳到流水，只看这次导入的未分类
          href={
            r.uncategorizedCount > 0
              ? `/transactions?quick=uncategorized&batch=${r.batchId}`
              : undefined
          }
          linkLabel="去分类"
        />
      </div>

      <ReconciliationCard r={r} />

      {r.balanceWarnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-600" />
              余额不连续（{r.balanceWarnings.length}）
            </CardTitle>
            <CardDescription>
              相邻两行的余额对不上，可能是文件被改过或银行导出不完整。导入照常完成了。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {r.balanceWarnings.map((w) => (
                <li key={`${w.line}-${w.nextLine}`} className="rounded-md bg-amber-50 px-3 py-2">
                  {w.message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {r.possibleDuplicates.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Copy className="size-5 text-amber-600" />
              可能重复（{r.possibleDuplicates.length}）
            </CardTitle>
            <CardDescription>
              银行这笔同时对上了好几笔手动录入，没法自动确认，已经按新交易导入。请人工核对。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {r.possibleDuplicates.map((d) => (
              <div key={d.transaction.id} className="rounded-md border p-3 text-sm">
                <TxLine tx={d.transaction} />
                <p className="mt-2 mb-1 text-xs text-muted-foreground">可能是这几笔手动录入：</p>
                <ul className="flex flex-col gap-1 pl-3">
                  {d.pendings.map((p) => (
                    <li key={p.id}>
                      <TxLine tx={p} muted />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {r.pendingToCheck.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="size-5 text-muted-foreground" />
              待检查的手动录入（{r.pendingToCheck.length}）
            </CardTitle>
            <CardDescription>
              超过 3 天还没对上银行流水。可能金额录错、账户选错，或者其实是现金。
            </CardDescription>
            {/* M4-7：流水里列出这个账户所有待确认的（包括还没超过 3 天的） */}
            <CardAction>
              <Link
                href={`/transactions?status=pending&account=${r.account.id}`}
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                在流水里查看
                <ChevronRight className="size-4" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {r.pendingToCheck.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="break-words">{p.merchant}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.date} · {p.memberName}
                      {p.note && ` · ${p.note}`}
                    </span>
                  </div>
                  <span className="shrink-0 tabular-nums">{formatAud(p.amountCents)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {!hasNotices && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-green-600" />
          没有需要处理的提醒。
        </p>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  warn = false,
  href,
  linkLabel,
}: {
  label: string;
  value: number;
  hint: string;
  warn?: boolean;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="flex flex-col gap-1 px-4">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className={cn('text-3xl font-semibold tabular-nums', warn && 'text-amber-600')}>
          {value}
        </span>
        <span className="flex flex-wrap items-center justify-between gap-x-2 text-xs text-muted-foreground">
          {hint}
          {href && (
            <Link
              href={href}
              className="flex items-center font-medium text-amber-700 hover:text-amber-900"
            >
              {linkLabel}
              <ChevronRight className="size-3.5" />
            </Link>
          )}
        </span>
      </CardContent>
    </Card>
  );
}

function TxLine({ tx, muted = false }: { tx: ResultTx; muted?: boolean }) {
  return (
    <span
      className={cn('flex items-start justify-between gap-3', muted && 'text-muted-foreground')}
    >
      <span className="min-w-0 break-words">
        {tx.date} · {tx.merchant}
      </span>
      <span className="shrink-0 tabular-nums">{formatAud(tx.amountCents)}</span>
    </span>
  );
}

// R9：opening + Σ(confirmed) == closing。差额 = closing − (opening + Σ)
function ReconciliationCard({ r }: { r: ImportResultView }) {
  const { reconciliation: rec, openingBalanceCents: opening, closingBalanceCents: closing } = r;

  if (rec.status === 'none' || opening === null || closing === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CircleSlash className="size-5 text-muted-foreground" />
            没有对账
          </CardTitle>
          <CardDescription>
            这次没填期初和期末余额。下次导入时可以参考 PDF 对账单填上，检查有没有漏导或重复。
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const passed = rec.status === 'passed';
  const sum = closing - opening - rec.differenceCents; // 数据库里这段时间 confirmed 交易的合计
  return (
    <Card className={cn(!passed && 'border-destructive/40')}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {passed ? (
            <CheckCircle2 className="size-5 text-green-600" />
          ) : (
            <XCircle className="size-5 text-destructive" />
          )}
          {passed ? '对账通过' : '对账不通过'}
          {!passed && (
            <span className="text-destructive">
              差额 {rec.differenceCents > 0 ? '+' : ''}
              {formatAud(rec.differenceCents)}
            </span>
          )}
        </CardTitle>
        <CardDescription>
          {r.account.bank === 'cba' ? 'CBA 的期初期末从余额列自动算出。' : ''}
          按数据库里这个账户 {r.dateFrom} 至 {r.dateTo} 的已确认交易计算，待确认的不算。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md bg-muted px-4 py-3 text-sm">
          <span>
            期初 <strong className="tabular-nums">{formatAud(opening)}</strong>
          </span>
          <span className="text-muted-foreground">+</span>
          <span>
            本期合计 <strong className="tabular-nums">{formatAud(sum)}</strong>
          </span>
          <span className="text-muted-foreground">=</span>
          <span>
            {passed ? '期末' : '算出的期末'}{' '}
            <strong className="tabular-nums">{formatAud(opening + sum)}</strong>
          </span>
          {!passed && (
            <span className="text-muted-foreground">（对账单期末 {formatAud(closing)}）</span>
          )}
        </div>
        {!passed && (
          <p className="text-sm text-muted-foreground">
            {rec.differenceCents > 0
              ? '对账单比算出的多：可能漏导了收入，或者多算了支出。'
              : '对账单比算出的少：可能漏导了支出，或者有交易重复了。'}
            也检查一下期初期末是不是填错了。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
