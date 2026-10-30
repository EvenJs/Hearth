import { connection } from 'next/server';
import { Suspense } from 'react';
import { todayInMelbourne } from '@/lib/rules/periods';
import { financialYearOf } from '@/lib/tax/estimate';
import { availableFinancialYears, financialYearLabel } from '@/lib/tax/rates';
import { getHouseholdContext } from '@/server/context';
import { getHouseholdTax } from '@/server/tax';
import { TaxView } from './tax-view';

// 设置 → 税务（设计图 11，M7-5，R14.1、R14.6、R14.7）
// 财年放在 ?fy=2026；不带或不在下拉里时，默认今天所在的财年，没有税率表时选有表的最近一个（R14.7）
export default function TaxPage(props: PageProps<'/settings/tax'>) {
  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">设置 / 税务</p>
        <h1 className="text-2xl font-semibold">税务</h1>
        <p className="text-sm text-muted-foreground">
          每人每财年填一次工资，估算年底要补多少税。
        </p>
      </header>

      {/* 读 session 和 searchParams 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <TaxSection searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}

// 有表的财年里离 target 最近的；一样近时取新的（years 从新到旧）
function nearestYear(years: number[], target: number): number | null {
  let best: number | null = null;
  for (const y of years) {
    if (best === null || Math.abs(y - target) < Math.abs(best - target)) best = y;
  }
  return best;
}

async function TaxSection({
  searchParams,
}: {
  searchParams: PageProps<'/settings/tax'>['searchParams'];
}) {
  const { fy } = await searchParams;
  const ctx = await getHouseholdContext();
  // "今天"每次请求都要重新算，不能被预渲染
  await connection();
  const years = availableFinancialYears();
  const currentYear = financialYearOf(todayInMelbourne());
  const requested = Number(fy);
  const selected = years.includes(requested) ? requested : nearestYear(years, currentYear);

  // R14.7：今天所在的财年没有税率表时一直提示
  const missingRates = years.includes(currentYear) ? null : financialYearLabel(currentYear);

  const tax = selected === null ? null : await getHouseholdTax(ctx, selected);

  return (
    <TaxView
      years={years.map((y) => ({ value: y, label: financialYearLabel(y) }))}
      missingRates={missingRates}
      tax={tax && tax.missingRates === null ? tax : null}
    />
  );
}
