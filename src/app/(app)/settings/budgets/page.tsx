import { Suspense } from 'react';
import { pickerSections } from '@/lib/transactions/category-picker';
import { todayInMelbourne } from '@/lib/rules/periods';
import { listBudgetsWithProgress } from '@/server/budgets';
import { listCategoryTree } from '@/server/categories';
import { getHouseholdContext } from '@/server/context';
import type { CategoryRef } from '@/server/transactions';
import { BudgetsView, type CategoryRefMap } from './budgets-view';

// 设置 → 预算（设计图 10，M7-3，R11、R11.1、R11.3）
// 固定本月、全家，不跟看板筛选（R11.3）
export default function BudgetsPage() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">设置 / 预算</p>
        <h1 className="text-2xl font-semibold">预算</h1>
        <p className="text-sm text-muted-foreground">
          按自然月算，只看本月、全家。达到提醒百分比变琥珀色，超过上限变红。
        </p>
      </header>

      {/* 读 session 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <BudgetsSection />
      </Suspense>
    </>
  );
}

async function BudgetsSection() {
  const ctx = await getHouseholdContext();
  const today = todayInMelbourne();
  const [{ budgets, overview }, tree] = await Promise.all([
    listBudgetsWithProgress(ctx, today),
    listCategoryTree(ctx),
  ]);

  // 分类 tag 用的 CategoryRef。预算不会指向归档的分类（R19.4），未归档的树就够了
  const refs: CategoryRefMap = {};
  for (const t of tree) {
    const top = { id: t.id, nameEn: t.nameEn, nameZh: t.nameZh };
    refs[t.id] = { ...top, kind: t.kind, systemKey: t.systemKey, parent: null } satisfies CategoryRef;
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

  // R11.2：支出类一级、二级 + 现金支出。已经有预算的也列着，保存时服务端报"已经有预算"
  const all = pickerSections(tree, { includeTransfer: false });
  const sections = {
    groups: all.groups.filter((g) => g.kind === 'expense'),
    system: all.system.filter((g) => g.systemKey === 'cash_withdrawal'),
  };

  return <BudgetsView budgets={budgets} overview={overview} refs={refs} sections={sections} />;
}
