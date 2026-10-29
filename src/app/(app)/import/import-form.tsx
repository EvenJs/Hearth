'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, CalendarClock, FileText, Info } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
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
import { BANK_LABELS, type Bank } from '@/lib/accounts/account-input';
import type { ImportCoverage } from '@/lib/import/coverage';
import {
  checkImportFile,
  importFormSchema,
  type ImportFormInput,
  type ImportFormValues,
} from '@/lib/import/import-input';
import { cn } from '@/lib/utils';
import { importFileAction, type ImportField } from './actions';

export type ImportAccount = {
  id: string;
  name: string;
  bank: Bank;
  numberSuffix: string | null;
  defaultMemberName: string;
  coverage: ImportCoverage; // R12.2
};

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

type FormProps = { accounts: ImportAccount[] };

// cacheComponents 下离开页面时 Next 用 <Activity> 把页面藏起来，state 和 DOM（包括选的文件）都会留着
// 导入成功后 redirect 走了，回来时不该看到上一次的账户、文件和余额：页面被隐藏时换 key，整个表单重新挂载
// 填到一半去别的页面不清空；导入失败留在本页，也不清空，方便改了再传
// 见 docs/tech-stack.md 2. 关键约定 "页面状态"
export function ImportForm({ accounts }: FormProps) {
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
      onSubmitStart={() => (resetOnHide.current = true)}
      onSubmitFailed={() => (resetOnHide.current = false)}
    />
  );
}

function ImportFormInner({
  accounts,
  onSubmitStart,
  onSubmitFailed,
}: FormProps & { onSubmitStart: () => void; onSubmitFailed: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<ImportFormInput, unknown, ImportFormValues>({
    resolver: zodResolver(importFormSchema),
    // 只有一个账户时直接选上
    defaultValues: {
      accountId: accounts.length === 1 ? accounts[0].id : '',
      openingBalance: '',
      closingBalance: '',
    },
  });

  const accountId = useWatch({ control: form.control, name: 'accountId' });
  const selected = accounts.find((a) => a.id === accountId);
  const isAnz = selected?.bank === 'anz';
  // R1C：ANZ 账户选了 .pdf 就是对账单，期初期末从汇总页读，不用填
  const isPdf = selected && file ? checkImportFile(file, selected.bank).kind === 'pdf' : false;
  const balanceInputs = isAnz && !isPdf;

  // 余额框藏起来时清掉，免得藏起来的输入框挡住提交
  function clearBalances() {
    form.setValue('openingBalance', '');
    form.setValue('closingBalance', '');
    form.clearErrors(['openingBalance', 'closingBalance']);
  }

  function selectAccount(id: string) {
    form.setValue('accountId', id, { shouldValidate: form.formState.isSubmitted });
    const bank = accounts.find((a) => a.id === id)?.bank;
    if (!bank) return;
    // CBA 不填余额（R1B.2 自动算）；已经选的文件按新账户的银行重新检查（CBA 不收 PDF）
    const kind = file ? checkImportFile(file, bank).kind : null;
    if (bank !== 'anz' || kind === 'pdf') clearBalances();
    setFileError(file ? checkImportFile(file, bank).error : null);
  }

  function onFileChange(f: File | null) {
    setFile(f);
    if (!f || !selected) {
      setFileError(null);
      return;
    }
    const checked = checkImportFile(f, selected.bank);
    setFileError(checked.error);
    if (checked.kind === 'pdf') clearBalances();
  }

  async function onSubmit() {
    setFormError(null);
    if (!selected) return;
    if (!file) {
      setFileError('请选择文件');
      return;
    }
    const err = checkImportFile(file, selected.bank).error;
    if (err) {
      setFileError(err);
      return;
    }

    const values = form.getValues();
    const data = new FormData();
    data.set('accountId', values.accountId);
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
    if (!result.fieldErrors) setFormError(result.message);
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex max-w-3xl flex-col gap-6">
        {/* 1. 选择账户 */}
        <Card>
          <CardHeader>
            <CardTitle>1. 选择账户</CardTitle>
            <CardDescription>流水会归到这个账户，按账户的银行选解析器</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <FormField
              control={form.control}
              name="accountId"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <div role="radiogroup" aria-label="账户" className="grid gap-3 sm:grid-cols-2">
                      {accounts.map((a) => {
                        const checked = field.value === a.id;
                        return (
                          <button
                            key={a.id}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            onClick={() => selectAccount(a.id)}
                            className={cn(
                              'flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors',
                              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                              checked
                                ? 'border-primary ring-1 ring-primary'
                                : 'hover:border-primary/50',
                            )}
                          >
                            <span className="flex items-center gap-2">
                              <Badge variant="secondary">{BANK_LABELS[a.bank]}</Badge>
                              <span className="truncate font-medium">{a.name}</span>
                            </span>
                            <span className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                              <span>{a.numberSuffix ? `•••• ${a.numberSuffix}` : '没填尾号'}</span>
                              <span className="truncate">{a.defaultMemberName}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {selected && <CoverageNotice coverage={selected.coverage} />}
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" />
              ANZ Plus 和现金账户不能导入 CSV，用“记一笔”手动录入。
            </p>
          </CardContent>
        </Card>

        {/* 2. 上传文件，选了账户才显示。ANZ 收 CSV 和 PDF 对账单（R1C），CBA 只收 CSV */}
        {selected && (
          <Card>
            <CardHeader>
              <CardTitle>{isAnz ? '2. 上传 CSV 或 PDF 对账单' : '2. 上传 CSV'}</CardTitle>
              <CardDescription>
                {isAnz
                  ? '网银导出的原始 CSV（不超过 1 MB），或者网银下载的 PDF 对账单（不超过 1.5 MB）。文件本身不会保存'
                  : '网银导出的原始 CSV，不超过 1 MB。文件本身不会保存'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Input
                type="file"
                accept={isAnz ? '.csv,text/csv,.pdf,application/pdf' : '.csv,text/csv'}
                aria-label={isAnz ? 'CSV 或 PDF 文件' : 'CSV 文件'}
                aria-invalid={fileError ? true : undefined}
                onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
                className="cursor-pointer"
              />
              {file && !fileError && (
                <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                  <FileText className="size-4 shrink-0" />
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0">· {formatSize(file.size)}</span>
                </p>
              )}
              {fileError && <p className="text-sm text-destructive">{fileError}</p>}
            </CardContent>
          </Card>
        )}

        {/* 3. 对账（ANZ CSV 可选手填；ANZ 对账单从汇总页读；CBA 从余额列自动算） */}
        {selected && (
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
                  ? '对账单的期初和期末余额会从汇总页自动读出来，不用填。还会和上一份对账单检查首尾接不接得上'
                  : isAnz
                    ? '可以参考 PDF 对账单填期初和期末余额，检查有没有漏导或重复。不填也能导入；也可以直接导入 PDF 对账单'
                    : 'CBA 的 CSV 带余额列，期初期末会自动算出来，不用填'}
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

        {selected && (
          <div>
            <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
              {submitting ? '导入中…' : '开始导入'}
            </Button>
          </div>
        )}
      </form>
    </Form>
  );
}

// R12.2 导入前：上次导到哪天、建议导出范围、对账单导到哪天。没导入过不显示
function CoverageNotice({ coverage }: { coverage: ImportCoverage }) {
  if (coverage.lastDateTo === null) return null;
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
            ，下一份从这天开始
          </span>
        )}
      </div>
    </div>
  );
}
