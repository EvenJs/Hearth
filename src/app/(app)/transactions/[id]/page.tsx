import { ArrowLeftRight, ChevronLeft, FileText } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatAud } from '@/lib/rules/money';
import { todayInMelbourne } from '@/lib/rules/periods';
import { pickerSections } from '@/lib/transactions/category-picker';
import { categoryOptionGroups } from '@/lib/transactions/inline-edit';
import { cn } from '@/lib/utils';
import { listCategoryTree } from '@/server/categories';
import { getHouseholdContext } from '@/server/context';
import { listMembers } from '@/server/members';
import { getTransaction, type TransactionDetail } from '@/server/transactions';
import { formatTxDate } from '../format';
import type { EditOptions } from '../inline-edit';
import { TxBadges } from '../tx-badges';
import { SplitSection } from './split-section';

// F8 交易详情和拆分（设计图 04，M4-10）
// 只看和拆分：编辑、删除整笔交易在 M6 做。设计图里文档没有的东西见 docs/design/README.md 第 4 节
// ?back= 是列表页的查询参数（筛选和页码），"返回流水"时带回去
export default function TransactionDetailPage(props: PageProps<'/transactions/[id]'>) {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
      <DetailSection params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

// back 只当作 /transactions 的查询参数用，路径固定，不会跳到别的地方
function backQuery(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string') return '';
  return new URLSearchParams(raw).toString();
}

async function DetailSection({
  params,
  searchParams,
}: {
  params: PageProps<'/transactions/[id]'>['params'];
  searchParams: PageProps<'/transactions/[id]'>['searchParams'];
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!z.uuid().safeParse(id).success) notFound();
  const back = backQuery(sp.back);
  const ctx = await getHouseholdContext();
  await connection(); // "今天"每次请求重新算
  const today = todayInMelbourne();
  const [tx, members, categories] = await Promise.all([
    getTransaction(ctx, id),
    listMembers(ctx),
    listCategoryTree(ctx),
  ]);
  if (!tx) notFound();

  const options: EditOptions = {
    categoryGroups: categoryOptionGroups(categories),
    categorySections: pickerSections(categories, { includeTransfer: false }), // R16.3
    members: members.map(({ id, name }) => ({ id, name })),
  };
  const listHref = back ? `/transactions?${back}` : '/transactions';
  const detailHref = (otherId: string) =>
    `/transactions/${otherId}${back ? `?back=${encodeURIComponent(back)}` : ''}`;

  return (
    <>
      <nav className="text-sm">
        <Link
          href={listHref}
          className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          返回流水
        </Link>
      </nav>

      <Summary tx={tx} today={today} />
      <InfoCard tx={tx} today={today} pairHref={tx.pair ? detailHref(tx.pair.id) : null} />
      <SplitSection tx={tx} options={options} />
    </>
  );
}

function Summary({ tx, today }: { tx: TransactionDetail; today: string }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <TxBadges tx={tx} />
          <TransferBadge status={tx.transferStatus} />
        </div>
        <h1 className="text-2xl font-semibold break-words">{tx.merchant}</h1>
        <p className="text-sm text-muted-foreground">
          {formatTxDate(tx.date, today)} · {tx.account.name}
          {tx.cardLast4 && <> · 卡 ••{tx.cardLast4}</>}
        </p>
      </div>
      <p
        className={cn(
          'shrink-0 text-3xl font-semibold tabular-nums',
          tx.amountCents > 0 && 'text-green-700',
        )}
      >
        {tx.amountCents > 0 ? '+' : ''}
        {formatAud(tx.amountCents)}
      </p>
    </header>
  );
}

// auto / confirmed 的转账。suggested 由 TxBadges 显示
function TransferBadge({ status }: { status: TransactionDetail['transferStatus'] }) {
  if (status !== 'auto' && status !== 'confirmed') return null;
  return (
    <Badge className="border-dashed border-border bg-transparent font-normal text-muted-foreground">
      <ArrowLeftRight />
      {status === 'auto' ? '内部转账（自动识别）' : '内部转账（已确认）'}
    </Badge>
  );
}

const SOURCE_LABELS: Record<TransactionDetail['source'], string> = {
  csv: 'CSV 导入',
  manual: '手动录入',
  receipt: '小票',
};

function InfoCard({
  tx,
  today,
  pairHref,
}: {
  tx: TransactionDetail;
  today: string;
  pairHref: string | null;
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="size-4" />
          交易信息
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">原始描述（已脱敏）</span>
          <p className="rounded-md bg-muted/60 px-3 py-2 font-mono text-sm break-all">
            {tx.rawDescription}
          </p>
        </div>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Item label="日期">{formatTxDate(tx.date, today)}</Item>
          <Item label="账户">{tx.account.name}</Item>
          <Item label="卡号尾号">{tx.cardLast4 ? `••${tx.cardLast4}` : '—'}</Item>
          <Item label="来源">{SOURCE_LABELS[tx.source]}</Item>
          <Item label="状态">{tx.status === 'pending' ? '待确认（pending）' : '已入账'}</Item>
          <Item label="导入批次">
            {tx.importBatch ? (
              <Link
                href={`/import/${tx.importBatch.id}`}
                className="break-all underline underline-offset-2"
              >
                {tx.importBatch.fileName}
              </Link>
            ) : (
              '—'
            )}
          </Item>
          <Item label="配对的另一半" className="sm:col-span-2 lg:col-span-3">
            {tx.pair && pairHref ? (
              <Link href={pairHref} className="underline underline-offset-2">
                {formatTxDate(tx.pair.date, today)} · {tx.pair.account.name} · {tx.pair.merchant}{' '}
                <span className="tabular-nums">{formatAud(tx.pair.amountCents)}</span>
              </Link>
            ) : (
              '—'
            )}
          </Item>
          <Item label="备注" className="sm:col-span-2 lg:col-span-3">
            {tx.note ? <span className="whitespace-pre-wrap">{tx.note}</span> : '—'}
          </Item>
        </dl>
      </CardContent>
    </Card>
  );
}

function Item({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
