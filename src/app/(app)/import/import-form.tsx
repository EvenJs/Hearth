'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  FileText,
  FileUp,
  Info,
  Loader2,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { AccountLabel } from '@/components/account-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Bank } from '@/lib/accounts/account-input';
import { canImportCsv, canImportStatement } from '@/lib/import/banks';
import type { ImportCoverage } from '@/lib/import/coverage';
import {
  checkImportFile,
  importFormSchema,
  type ImportFormInput,
  type ImportFormValues,
} from '@/lib/import/import-input';
import { addDays } from '@/lib/rules/periods';
import { cn } from '@/lib/utils';
import {
  identifyStatementAction,
  importFileAction,
  type IdentifiedAccount,
  type ImportField,
} from './actions';

export type ImportAccount = {
  id: string;
  name: string;
  bank: Bank;
  numberSuffix: string | null;
  defaultMemberName: string;
  coverage: ImportCoverage; // R12.2
};

// 第 1 步的文字按 fileBank 分：anz = CSV 和对账单都收，anz_plus = 只收对账单（家里只有 ANZ Plus、BOQ、Westpac 账户）
// R1E 以后能导 CSV 的银行（ANZ、CBA）都能导对账单，没有只收 CSV 的情况
type FileBank = Extract<Bank, 'anz' | 'anz_plus'>;
const UPLOAD_TITLE: Record<FileBank, string> = {
  anz: '1. 上传 CSV 或 PDF 对账单',
  anz_plus: '1. 上传 PDF 对账单',
};
// 哪个账户能导什么写在上面的小表里，这里只写大小限制
const UPLOAD_DESCRIPTION: Record<FileBank, string> = {
  anz: 'CSV 不超过 1 MB，PDF 对账单不超过 1.5 MB。对账单会自动认出是哪个账户',
  anz_plus: 'PDF 对账单不超过 1.5 MB，会自动认出是哪个账户',
};
const UPLOAD_ACCEPT: Record<FileBank, string> = {
  anz: '.csv,text/csv,.pdf,application/pdf',
  anz_plus: '.pdf,application/pdf',
};
const UPLOAD_LABEL: Record<FileBank, string> = {
  anz: 'CSV 或 PDF 文件',
  anz_plus: 'PDF 文件',
};

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

// 小表的"上次导到"：今年的写 MM-DD，不是今年的写全，免得看错年份
function formatCoverageDate(date: string, today: string): string {
  return date.slice(0, 4) === today.slice(0, 4) ? date.slice(5) : date;
}

type FormProps = { accounts: ImportAccount[]; today: string };

// cacheComponents 下离开页面时 Next 用 <Activity> 把页面藏起来，state 和 DOM（包括选的文件）都会留着
// 导入成功后 redirect 走了，回来时不该看到上一次的账户、文件和余额：页面被隐藏时换 key，整个表单重新挂载
// 填到一半去别的页面不清空；导入失败留在本页，也不清空，方便改了再传
// 见 docs/tech-stack.md 2. 关键约定 "页面状态"
export function ImportForm({ accounts, today }: FormProps) {
  const [formKey, setFormKey] = useState(0);
  const resetOnHide = useRef(false);

  useLayoutEffect(
    () => () => {
      if (!resetOnHide.current) return;
      resetOnHide.current = false;
      setFormKey((k) => k + 1);
    },
    [],
  );

  return (
    <ImportFormInner
      key={formKey}
      accounts={accounts}
      today={today}
      onSubmitStart={() => (resetOnHide.current = true)}
      onSubmitFailed={() => (resetOnHide.current = false)}
    />
  );
}

// 识别对账单的状态（M6.6-6b）。file 用来丢掉过时的结果：识别中又换了文件
type Identity =
  | { status: 'idle' }
  | { status: 'loading'; file: File }
  | { status: 'ok'; file: File; account: IdentifiedAccount }
  | { status: 'error'; file: File; message: string };

function ImportFormInner({
  accounts,
  today,
  onSubmitStart,
  onSubmitFailed,
}: FormProps & { onSubmitStart: () => void; onSubmitFailed: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity>({ status: 'idle' });
  const latestFile = useRef<File | null>(null);

  // 只有一个账户时直接选上（CSV 用）
  const defaultAccountId = accounts.length === 1 ? accounts[0].id : '';
  const form = useForm<ImportFormInput, unknown, ImportFormValues>({
    resolver: zodResolver(importFormSchema),
    defaultValues: { accountId: defaultAccountId, openingBalance: '', closingBalance: '' },
  });

  // R1C 到 R1G：ANZ、ANZ Plus、CBA、BOQ、Westpac 有对账单，ANZ、CBA 有 CSV。选账户之前按家里有的账户粗查文件类型：
  // 有 ANZ 或 CBA 时用 anz（收 .csv 和 .pdf），只有 ANZ Plus、BOQ、Westpac 用 anz_plus（只收 .pdf）
  const hasCsv = accounts.some((a) => canImportCsv(a.bank));
  const fileBank: FileBank = hasCsv ? 'anz' : 'anz_plus';
  const kind = file ? checkImportFile(file, fileBank).kind : null;
  const isPdf = kind === 'pdf';

  const accountId = useWatch({ control: form.control, name: 'accountId' });
  const selected = isPdf ? undefined : accounts.find((a) => a.id === accountId);
  const identified = isPdf && identity.status === 'ok' ? identity.account : null;
  // R1D、R1F、R1G：CSV 选了 ANZ Plus、BOQ、Westpac 账户，页面上就拦住，不用等服务端
  const accountFileError =
    file && selected && !isPdf ? checkImportFile(file, selected.bank).error : null;
  const csvAccount = accountFileError ? undefined : selected;
  const balanceInputs = !isPdf && csvAccount?.bank === 'anz';
  const canSubmit = file !== null && !fileError && (isPdf ? identified !== null : !!csvAccount);

  // 余额框藏起来时清掉，免得藏起来的输入框挡住提交
  function clearBalances() {
    form.setValue('openingBalance', '');
    form.setValue('closingBalance', '');
    form.clearErrors(['openingBalance', 'closingBalance']);
  }

  function selectAccount(id: string) {
    form.setValue('accountId', id, { shouldValidate: form.formState.isSubmitted });
    // CBA 不填余额（R1B.2 自动算）
    if (accounts.find((a) => a.id === id)?.bank !== 'anz') clearBalances();
  }

  // R1C 自动认账户：传了 PDF 就马上读，不写任何东西
  async function identify(f: File) {
    setIdentity({ status: 'loading', file: f });
    const data = new FormData();
    data.set('file', f);
    const r = await identifyStatementAction(data);
    if (latestFile.current !== f) return; // 识别中又换了文件
    if (r.ok) {
      setIdentity({ status: 'ok', file: f, account: r.account });
      // 表单校验要 accountId；服务端导入时会按对账单重新认一遍
      form.setValue('accountId', r.account.id);
    } else {
      setIdentity({ status: 'error', file: f, message: r.message });
    }
  }

  function onFileChange(f: File | null) {
    setFile(f);
    latestFile.current = f;
    setFormError(null);
    setIdentity({ status: 'idle' });
    if (!f) {
      setFileError(null);
      return;
    }
    const checked = checkImportFile(f, fileBank);
    setFileError(checked.error);
    if (checked.kind === 'pdf') {
      clearBalances();
      form.clearErrors('accountId');
      if (!checked.error) void identify(f);
    } else if (isPdf) {
      // 从 PDF 换成 CSV：识别出来的账户不算数，重新选
      form.setValue('accountId', defaultAccountId);
    }
  }

  async function onSubmit() {
    setFormError(null);
    if (!file) {
      setFileError('请选择文件');
      return;
    }
    const err = checkImportFile(file, selected?.bank ?? fileBank).error;
    if (err) {
      setFileError(err);
      return;
    }
    if (isPdf && !identified) return;

    const values = form.getValues();
    const data = new FormData();
    data.set('accountId', isPdf ? '' : values.accountId);
    data.set('openingBalance', balanceInputs ? values.openingBalance : '');
    data.set('closingBalance', balanceInputs ? values.closingBalance : '');
    data.set('file', file);

    // 成功时服务端直接跳到 /import/[batchId]，只有失败才会返回
    onSubmitStart();
    const result = await importFileAction(data);
    onSubmitFailed();
    const { file: fileFieldError, ...fieldErrors } = result.fieldErrors ?? {};
    if (fileFieldError) setFileError(fileFieldError);
    for (const [field, message] of Object.entries(fieldErrors)) {
      form.setError(field as Exclude<ImportField, 'file'>, { message });
    }
    // PDF 不显示账户那一栏，账户的错误放到红框里
    if (!result.fieldErrors || (isPdf && !fileFieldError)) setFormError(result.message);
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex max-w-3xl flex-col gap-6">
        <CoverageTable accounts={accounts} today={today} />

        {/* 1. 先传文件：PDF 对账单自动认账户（R1C 到 R1G），CSV 再选账户 */}
        <Card>
          <CardHeader>
            <CardTitle>{UPLOAD_TITLE[fileBank]}</CardTitle>
            <CardDescription>{UPLOAD_DESCRIPTION[fileBank]}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <FileDropzone
              file={file}
              kindLabel={kind === null ? null : isPdf ? '对账单' : 'CSV'}
              accept={UPLOAD_ACCEPT[fileBank]}
              label={UPLOAD_LABEL[fileBank]}
              invalid={fileError !== null}
              onFile={onFileChange}
            />
            {fileError && <p className="text-sm text-destructive">{fileError}</p>}
          </CardContent>
        </Card>

        {/* 2. 账户：PDF 显示认出来的账户，CSV 选账户。选了文件才显示 */}
        {file && !fileError && isPdf && <IdentityCard identity={identity} />}

        {file && !fileError && !isPdf && (
          <Card>
            <CardHeader>
              <CardTitle>2. 选择账户</CardTitle>
              <CardDescription>流水会归到这个账户，按账户的银行选解析器</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <FormField
                control={form.control}
                name="accountId"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <div
                        role="radiogroup"
                        aria-label="账户"
                        className="grid gap-3 sm:grid-cols-2"
                      >
                        {accounts.map((a) => (
                          <AccountOption
                            key={a.id}
                            account={a}
                            checked={field.value === a.id}
                            onSelect={() => selectAccount(a.id)}
                          />
                        ))}
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {accountFileError && (
                <p role="alert" className="text-sm text-destructive">
                  {accountFileError}，直接上传 PDF 对账单会自动认出账户。
                </p>
              )}
              {csvAccount && (
                <CoverageNotice bank={csvAccount.bank} coverage={csvAccount.coverage} />
              )}
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" />
                现金账户不能导入，用“记一笔”手动录入。
              </p>
            </CardContent>
          </Card>
        )}

        {/* 3. 对账（ANZ CSV 可选手填；对账单从对账单上读；CBA CSV 从余额列自动算） */}
        {(identified || csvAccount) && (
          <Card>
            <CardHeader>
              <CardTitle>
                3. 对账{' '}
                {balanceInputs && (
                  <span className="text-sm font-normal text-muted-foreground">（可选）</span>
                )}
              </CardTitle>
              <CardDescription>
                {isPdf
                  ? '对账单的期初和期末余额会从对账单上自动读出来，不用填。还会和上一份对账单检查首尾接不接得上'
                  : balanceInputs
                    ? '可以参考 PDF 对账单填期初和期末余额，检查有没有漏导或重复。不填也能导入；也可以直接导入 PDF 对账单'
                    : 'CBA 的 CSV 带余额列，期初期末会自动算出来，不用填；也可以直接导入 PDF 对账单'}
              </CardDescription>
            </CardHeader>
            {balanceInputs && (
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ['openingBalance', '期初余额', '文件第一天之前的余额'],
                    ['closingBalance', '期末余额', '文件最后一天结束时的余额'],
                  ] as const
                ).map(([name, label, hint]) => (
                  <FormField
                    key={name}
                    control={form.control}
                    name={name}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{label}</FormLabel>
                        <FormControl>
                          <Input inputMode="decimal" placeholder="例如 14,195.10" {...field} />
                        </FormControl>
                        <FormDescription>{hint}</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ))}
              </CardContent>
            )}
          </Card>
        )}

        {formError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="break-all">{formError}</span>
              <span className="text-destructive/80">什么都没有写入，改好文件后重新上传。</span>
            </div>
          </div>
        )}

        {canSubmit && (
          <div>
            <Button type="submit" loading={submitting} className="w-full sm:w-auto">
              开始导入
            </Button>
          </div>
        )}
      </form>
    </Form>
  );
}

// R12.2：不选账户也能看到每个账户导到哪天。数据就是 coverage.lastDateTo，没导入过写"还没导过"
function CoverageTable({ accounts, today }: { accounts: ImportAccount[]; today: string }) {
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">账户</TableHead>
            <TableHead>文件</TableHead>
            <TableHead className="px-4 text-right">上次导到</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="max-w-0 px-4">
                <span className="flex min-w-0 items-center gap-2">
                  <AccountLabel bank={a.bank} name={a.name} />
                  {a.numberSuffix && (
                    <span className="hidden shrink-0 text-muted-foreground sm:inline">
                      •••• {a.numberSuffix}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell className="w-px text-muted-foreground">
                {[canImportCsv(a.bank) && 'CSV', canImportStatement(a.bank) && 'PDF']
                  .filter(Boolean)
                  .join(' / ')}
              </TableCell>
              <TableCell className="w-px px-4 text-right tabular-nums">
                {a.coverage.lastDateTo === null ? (
                  <span className="text-muted-foreground">还没导过</span>
                ) : (
                  formatCoverageDate(a.coverage.lastDateTo, today)
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// 第 1 步的拖放区：拖进来或点击选文件，选了显示文件名、大小，能换。文件检查还是走 onFile → checkImportFile
function FileDropzone({
  file,
  kindLabel,
  accept,
  label,
  invalid,
  onFile,
}: {
  file: File | null;
  kindLabel: string | null;
  accept: string;
  label: string;
  invalid: boolean;
  onFile: (f: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const pick = () => inputRef.current?.click();

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // 拖到子元素上也会触发 dragleave，真的离开拖放区才取消高亮
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={cn(
        'rounded-lg border-2 border-dashed transition-colors',
        dragging
          ? 'border-primary bg-primary/5'
          : invalid
            ? 'border-destructive/60'
            : 'border-input',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // 清掉 value，再选同一个文件也会触发 onChange
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
      {file ? (
        <div className="flex items-center gap-3 p-4">
          <FileText className="size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{file.name}</span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {formatSize(file.size)}
              {kindLabel && <Badge variant="outline">{kindLabel}</Badge>}
            </span>
          </div>
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={pick}>
            换文件
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          className="flex w-full flex-col items-center gap-2 rounded-md px-4 py-8 text-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <FileUp className="size-6 text-muted-foreground" />
          <span className="text-sm font-medium">拖{label}到这里，或点击选择</span>
        </button>
      )}
    </div>
  );
}

function AccountOption({
  account: a,
  checked,
  onSelect,
}: {
  account: ImportAccount;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        checked ? 'border-primary ring-1 ring-primary' : 'hover:border-primary/50',
      )}
    >
      <span className="flex items-center gap-2">
        <AccountLabel bank={a.bank} name={a.name} className="font-medium" />
      </span>
      <span className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{a.numberSuffix ? `•••• ${a.numberSuffix}` : '没填尾号'}</span>
        <span className="truncate">{a.defaultMemberName}</span>
      </span>
    </button>
  );
}

// R1C 到 R1G 自动认账户的结果（M6.6-6b）
function IdentityCard({ identity }: { identity: Identity }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>2. 账户</CardTitle>
        <CardDescription>
          按对账单上的账号找尾号对得上的账户，只在同一家银行的账户里找（ANZ 对账单只找 ANZ
          账户，以此类推）
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {(identity.status === 'loading' || identity.status === 'idle') && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在读取对账单…
          </p>
        )}
        {identity.status === 'error' && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="break-all">{identity.message}</span>
              <span className="text-destructive/80">什么都没有写入。</span>
            </div>
          </div>
        )}
        {identity.status === 'ok' && (
          <>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <CheckCircle2 className="size-4 shrink-0 text-green-600" />
              识别为
              <AccountLabel
                bank={identity.account.bank}
                name={identity.account.name}
                className="font-medium"
              />
              {identity.account.numberSuffix && (
                <span className="text-muted-foreground">•••• {identity.account.numberSuffix}</span>
              )}
            </p>
            <CoverageNotice bank={identity.account.bank} coverage={identity.account.coverage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// R12.2 导入前：上次导到哪天、建议导出范围、对账单导到哪天。没导入过不显示
// 下一份对账单的开始日：ANZ 账期 (from, to]，下一份印的开始日就是 to（R1C）；其他是 [from, to]，从第二天开始（R1D 到 R1G）
function CoverageNotice({ bank, coverage }: { bank: Bank; coverage: ImportCoverage }) {
  if (coverage.lastDateTo === null) return null;
  const nextStatementFrom =
    coverage.statementDateTo &&
    (bank === 'anz' ? coverage.statementDateTo : addDays(coverage.statementDateTo, 1));
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2.5 text-sm">
      <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span>
          上次导入到 <strong className="tabular-nums">{coverage.lastDateTo}</strong>，建议导出{' '}
          <strong className="tabular-nums">{coverage.suggestedFrom}</strong> 到今天（
          <span className="tabular-nums">{coverage.suggestedTo}</span>）
        </span>
        <span className="text-xs text-muted-foreground">
          故意往前多选一周，晚入账的会补上，重复的自动跳过。
        </span>
        {coverage.statementDateTo && (
          <span className="text-muted-foreground">
            对账单已经导到 <span className="tabular-nums">{coverage.statementDateTo}</span>
            ，下一份从 <span className="tabular-nums">{nextStatementFrom}</span> 开始
          </span>
        )}
      </div>
    </div>
  );
}
