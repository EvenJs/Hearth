import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { formatAud } from '@/lib/rules/money';
import { pickerSections } from '@/lib/transactions/category-picker';
import { categoryOptionGroups } from '@/lib/transactions/inline-edit';
import { todayInMelbourne } from '@/lib/rules/periods';
import {
  filtersFromSearchParams,
  hasSplitFilter,
  pageFromSearchParams,
} from '@/lib/transactions/filters';
import { listAccounts } from '@/server/accounts';
import { listCategoryTree } from '@/server/categories';
import { getHouseholdContext } from '@/server/context';
import { listMembers } from '@/server/members';
import { countQuickFilters, listTransactions } from '@/server/transactions';
import { FilterBar, type FilterOptions } from './filter-bar';
import type { EditOptions } from './inline-edit';
import { transactionsHref } from './href';
import { Pagination } from './pagination';
import { QuickFilters } from './quick-filters';
import { TransactionList } from './transaction-list';

// F8 流水查询（设计图 03，M4-7）：筛选条件全在 URL 参数里（src/lib/transactions/filters.ts）
// 没有参数 = 全部时间、全部交易
export default function TransactionsPage(props: PageProps<'/transactions'>) {
  return (
    <>
      <header>
        <h1 className="text-2xl font-semibold">流水</h1>
      </header>
      {/* 读 session 和 searchParams 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <TransactionsSection searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}

async function TransactionsSection({
  searchParams,
}: {
  searchParams: PageProps<'/transactions'>['searchParams'];
}) {
  const params = await searchParams;
  const filters = filtersFromSearchParams(params);
  const page = pageFromSearchParams(params);
  const ctx = await getHouseholdContext();
  // "今天"每次请求都要重新算，不能被预渲染（cacheComponents 不允许直接用 new Date()）
  await connection();
  const today = todayInMelbourne();
  const [list, counts, accounts, members, categories] = await Promise.all([
    listTransactions(ctx, filters, { page, today }),
    countQuickFilters(ctx),
    listAccounts(ctx, { includeArchived: true }), // 老交易可能在已归档的账户上
    listMembers(ctx),
    listCategoryTree(ctx),
  ]);
  const options: FilterOptions = {
    accounts: accounts.map(({ id, name, isArchived }) => ({ id, name, isArchived })),
    members: members.map(({ id, name }) => ({ id, name })),
    categorySections: pickerSections(categories, { includeTransfer: true }), // 筛选时都能选
  };
  // M4-8 行内修改的下拉选项（R16.3）
  const editOptions: EditOptions = {
    categoryGroups: categoryOptionGroups(categories),
    categorySections: pickerSections(categories, { includeTransfer: false }), // R16.3
    members: options.members,
  };
  const totalPages = Math.max(1, Math.ceil(list.count / list.pageSize));

  return (
    <>
      <FilterBar filters={filters} options={options} />
      <QuickFilters filters={filters} counts={counts} />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-muted-foreground">
          共 <strong className="text-foreground tabular-nums">{list.count}</strong> 笔
        </span>
        <span className="text-sm text-muted-foreground">
          合计{' '}
          <strong className="text-lg text-foreground tabular-nums">
            {formatAud(list.totalCents)}
          </strong>
        </span>
        {/* R16.5 */}
        {hasSplitFilter(filters) && (
          <span className="text-xs text-muted-foreground">拆过的交易只算命中条件的拆分</span>
        )}
      </div>

      {list.items.length > 0 ? (
        <TransactionList
          items={list.items}
          today={today}
          options={editOptions}
          listHref={transactionsHref(filters, page)}
        />
      ) : (
        <div className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">
          {list.count > 0 ? (
            <>
              这一页没有交易。
              <Link href={transactionsHref(filters)} className="underline">
                回到第 1 页
              </Link>
            </>
          ) : (
            '没有符合条件的交易。'
          )}
        </div>
      )}

      <Pagination filters={filters} page={page} totalPages={totalPages} />
    </>
  );
}
