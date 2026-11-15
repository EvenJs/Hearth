import { History } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { TableSkeleton } from '@/components/skeletons';
import { Button } from '@/components/ui/button';
import { canImportCsv, canImportStatement } from '@/lib/import/banks';
import { todayInMelbourne } from '@/lib/rules/periods';
import { listAccounts } from '@/server/accounts';
import { getHouseholdContext } from '@/server/context';
import { getImportCoverage } from '@/server/imports';
import { ImportForm, type ImportAccount } from './import-form';

// F2 导入（设计图 06）：CSV，ANZ、ANZ Plus、CBA、BOQ、Westpac 能传 PDF 对账单（R1C 到 R1G）；R12.2 上次导到哪天。结果页 /import/[batchId]，历史页 /import/history
export default function ImportPage() {
  return (
    <>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">导入银行流水</h1>
          <p className="text-sm text-muted-foreground">
            上传网银导出的 CSV 或 PDF 对账单，自动去重、分类、配对内部转账。文件本身不保存。
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="w-fit shrink-0">
          <Link href="/import/history">
            <History className="size-4" />
            导入历史
          </Link>
        </Button>
      </header>

      {/* 读 session 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<TableSkeleton />}>
        <ImportSection />
      </Suspense>
    </>
  );
}

async function ImportSection() {
  const ctx = await getHouseholdContext();
  // 只列能导入、没归档的账户（现金、其他不出现）；ANZ Plus、BOQ、Westpac 只能导对账单（R1D、R1F、R1G）
  const importable = (await listAccounts(ctx)).filter(
    (a) => canImportCsv(a.bank) || canImportStatement(a.bank),
  );
  // R12.2：每个账户上次导到哪天、对账单导到哪天。账户就几个，逐个查
  const accounts: ImportAccount[] = await Promise.all(
    importable.map(async (a) => ({
      id: a.id,
      name: a.name,
      bank: a.bank,
      numberSuffix: a.numberSuffix,
      defaultMemberName: a.defaultMemberName,
      coverage: await getImportCoverage(ctx, a.id),
    })),
  );

  if (accounts.length === 0) {
    return (
      <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        还没有能导入的账户（ANZ、ANZ Plus、CBA、BOQ 或 Westpac）。先去{' '}
        <Link href="/settings/accounts" className="text-primary underline underline-offset-4">
          账户设置
        </Link>{' '}
        添加。
      </p>
    );
  }
  return <ImportForm accounts={accounts} today={todayInMelbourne()} />;
}
