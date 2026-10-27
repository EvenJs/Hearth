import { Suspense } from 'react';
import { listCategoriesForAdmin } from '@/server/categories';
import { getHouseholdContext } from '@/server/context';
import { listMembers } from '@/server/members';
import { CategoriesView } from './categories-view';

// 设置 → 分类（设计图 13，M6.5-7，R19）
// "显示已归档"写在 URL 上（?archived=1），和账户页一样
export default function CategoriesPage(props: PageProps<'/settings/categories'>) {
  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">设置 / 分类</p>
        <h1 className="text-2xl font-semibold">分类</h1>
        <p className="text-sm text-muted-foreground">
          两级分类：一级下面是二级，每个一级都有一个 Other。不能删除，只能归档。
        </p>
      </header>

      {/* 读 session 和 searchParams 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <CategoriesSection searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}

async function CategoriesSection({
  searchParams,
}: {
  searchParams: PageProps<'/settings/categories'>['searchParams'];
}) {
  const showArchived = (await searchParams).archived === '1';
  const ctx = await getHouseholdContext();
  const [list, members] = await Promise.all([listCategoriesForAdmin(ctx), listMembers(ctx)]);
  return <CategoriesView list={list} members={members} showArchived={showArchived} />;
}
