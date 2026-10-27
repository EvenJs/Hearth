import { Suspense } from 'react';
import { filterRules } from '@/lib/rules/rule-admin';
import { pickerSections } from '@/lib/transactions/category-picker';
import { listCategoryTree } from '@/server/categories';
import { getHouseholdContext } from '@/server/context';
import { listRules } from '@/server/rules';
import { RulesView, type CategoryRefMap, type TopOption } from './rules-view';

// 设置 → 规则（设计图 12，M6.5-4，R18）
// 筛选写在 URL 上：?q=关键词、?category=一级 id（R19.4 "先去规则页"的链接直接用）
export default function RulesPage(props: PageProps<'/settings/rules'>) {
  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">设置 / 规则</p>
        <h1 className="text-2xl font-semibold">分类规则</h1>
        <p className="text-sm text-muted-foreground">导入时按商家名自动分类。关键词越长越优先。</p>
      </header>

      {/* 读 session 和 searchParams 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <RulesSection searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
}

async function RulesSection({
  searchParams,
}: {
  searchParams: PageProps<'/settings/rules'>['searchParams'];
}) {
  const params = await searchParams;
  const q = one(params.q);
  const category = one(params.category);

  const ctx = await getHouseholdContext();
  const [all, tree] = await Promise.all([listRules(ctx), listCategoryTree(ctx)]);

  // listRules 每条都带了一级 id，按一级筛选用它，规则指向已归档的二级也能筛到
  const categories = all.map((r) => ({
    id: r.categoryId,
    parentId: r.categoryId === r.topCategoryId ? null : r.topCategoryId,
  }));
  const rules = filterRules(all, { search: q, topCategoryId: category || undefined }, categories);

  // 分类 tag 用的 CategoryRef（未归档的分类；指向归档分类的规则只显示名字）
  const refs: CategoryRefMap = {};
  for (const t of tree) {
    const top = { id: t.id, nameEn: t.nameEn, nameZh: t.nameZh };
    refs[t.id] = { ...top, kind: t.kind, systemKey: t.systemKey, parent: null };
    for (const c of t.children) {
      refs[c.id] = {
        id: c.id,
        nameEn: c.nameEn,
        nameZh: c.nameZh,
        kind: t.kind,
        systemKey: null,
        parent: top,
      };
    }
  }

  // 一级筛选的选项：能有规则指向的一级（不含内部转账，R16.3）
  const tops: TopOption[] = tree
    .filter((t) => t.systemKey !== 'internal_transfer')
    .map((t) => ({ id: t.id, name: t.nameEn }));

  return (
    <RulesView
      rules={rules}
      totalCount={all.length}
      q={q}
      category={category}
      tops={tops}
      refs={refs}
      sections={pickerSections(tree, { includeTransfer: false })} // R16.3
    />
  );
}
