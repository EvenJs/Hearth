import { ArrowRight, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { formatAud } from '@/lib/rules/money';
import { financialYearLabel } from '@/lib/tax/rates';
import { cn } from '@/lib/utils';
import type { Member } from '@/server/members';
import type { HouseholdTax, PersonTax } from '@/server/tax';

// F6 看板的税务卡片（设计图 02，R14.6、R14.7；放在支出分类上面单独一行，不在右栏）：固定今天所在的财年，不跟看板的时间段
// 归属人筛选选了某个 person 只显示他的卡片；"全部"、Home（和 child）显示所有 person
// 数字和设置页一样来自 getHouseholdTax，不另算

type Props = {
  tax: HouseholdTax;
  memberId: string | undefined;
  members: Member[];
};

export function TaxCards({ tax, memberId, members }: Props) {
  if (tax.missingRates !== null) {
    return (
      <Card className="min-w-0 gap-3 p-4 lg:p-6">
        <h2 className="text-lg font-semibold">预计年底补税</h2>
        {/* R14.7：卡片位置显示提示，看板其他区块照常 */}
        <Warn>
          缺 {tax.missingRates} 税率表，去 <code>src/lib/tax/rates.ts</code> 加上
        </Warn>
      </Card>
    );
  }

  const selected = members.find((m) => m.id === memberId);
  const persons =
    selected?.kind === 'person'
      ? tax.persons.filter((p) => p.member.id === selected.id)
      : tax.persons;

  return (
    <Card className="min-w-0 gap-3 p-4 lg:p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold">
          预计年底补税
          <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
            {financialYearLabel(tax.financialYear)} 财年
          </span>
        </h2>
        <Link
          href="/settings/tax"
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          税务设置
          <ArrowRight className="size-3" />
        </Link>
      </div>

      {persons.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">没有个人归属人</p>
      ) : (
        // 单独一行（不在右栏）：手机一人一行，宽度够时并排
        <ul className="grid gap-3 sm:grid-cols-2">
          {persons.map((p) => (
            <li key={p.member.id} className="min-w-0">
              <PersonCard person={p} />
            </li>
          ))}
        </ul>
      )}

      {tax.taxCategoryMissing && <Warn>找不到 Income / Tax (ATO) 分类，已预缴按 0 算</Warn>}

      {/* R14.6：卡片上写明"估算，以 ATO 为准"，每人都一样，写一次 */}
      <p className="text-xs text-muted-foreground">估算，以 ATO 为准</p>
    </Card>
  );
}

// R14.6：已缴 = 已代扣 + 已预缴，合成一个数；补税是负数时写"预计退税"
// 上面一行名字和补税金额，下面三列小字
function PersonCard({ person }: { person: PersonTax }) {
  const { estimate } = person;
  const refund = estimate.owingCents < 0;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 truncate pt-0.5 text-sm font-medium">{person.member.name}</span>
        <div className="flex shrink-0 flex-col items-end">
          <span
            className={cn(
              'text-xl font-semibold tabular-nums',
              refund && 'text-green-700 dark:text-green-500',
            )}
          >
            {formatAud(Math.abs(estimate.owingCents))}
          </span>
          <span className="text-xs text-muted-foreground">
            {refund ? '预计退税' : '预计年底补税'}
          </span>
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2 border-t pt-2 text-xs">
        {/* 工资 + 税前收入，和设置页的"应纳税收入"一样（R14.6，2026-10-30） */}
        <Stat label="应纳税收入" cents={estimate.taxableDollars * 100} />
        <Stat label="预计总税额" cents={estimate.totalCents} />
        <Stat label="已缴" cents={estimate.paygWithheldCents + estimate.prepaidCents} />
      </dl>
      {!estimate.hasProfile && (
        <Link
          href="/settings/tax"
          className="flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 hover:underline dark:bg-amber-950 dark:text-amber-300"
        >
          还没填工资，估算按 0 算，去设置页填
          <ArrowRight className="size-3 shrink-0" />
        </Link>
      )}
    </div>
  );
}

function Stat({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="truncate tabular-nums">{formatAud(cents)}</dd>
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 break-words">{children}</p>
    </div>
  );
}
