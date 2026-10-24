import Link from 'next/link';
import { Suspense } from 'react';
import { canImportCsv } from '@/lib/import/banks';
import { listAccounts } from '@/server/accounts';
import { getHouseholdContext } from '@/server/context';
import { ImportForm, type ImportAccount } from './import-form';

// F2 CSV 导入（设计图 06）。结果页 /import/[batchId] 在 M3-8 做
export default function ImportPage() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">导入银行流水</h1>
        <p className="text-sm text-muted-foreground">
          上传 ANZ 或 CBA 网银导出的 CSV，自动去重、分类、配对内部转账。
        </p>
      </header>

      {/* 读 session 的部分放在 Suspense 里（cacheComponents） */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">加载中…</p>}>
        <ImportSection />
      </Suspense>
    </>
  );
}

async function ImportSection() {
  const ctx = await getHouseholdContext();
  // 只列能导入、没归档的账户（ANZ Plus、现金不出现）
  const accounts: ImportAccount[] = (await listAccounts(ctx))
    .filter((a) => canImportCsv(a.bank))
    .map((a) => ({
      id: a.id,
      name: a.name,
      bank: a.bank,
      numberSuffix: a.numberSuffix,
      defaultMemberName: a.defaultMemberName,
    }));

  if (accounts.length === 0) {
    return (
      <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        还没有能导入 CSV 的账户（ANZ 或 CBA）。先去{' '}
        <Link href="/settings/accounts" className="text-primary underline underline-offset-4">
          账户设置
        </Link>{' '}
        添加。
      </p>
    );
  }
  return <ImportForm accounts={accounts} />;
}
