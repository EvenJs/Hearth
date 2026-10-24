'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, FileText, Info } from 'lucide-react';
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
import {
  checkCsvFile,
  importFormSchema,
  type ImportFormInput,
  type ImportFormValues,
} from '@/lib/import/import-input';
import { cn } from '@/lib/utils';
import { importCsvAction, type ImportField } from './actions';

export type ImportAccount = {
  id: string;
  name: string;
  bank: Bank;
  numberSuffix: string | null;
  defaultMemberName: string;
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

  function selectAccount(id: string) {
    form.setValue('accountId', id, { shouldValidate: form.formState.isSubmitted });
    // CBA 不填余额（R1B.2 自动算），切过去时清掉，免得隐藏的输入框挡住提交
    if (accounts.find((a) => a.id === id)?.bank !== 'anz') {
      form.setValue('openingBalance', '');
      form.setValue('closingBalance', '');
      form.clearErrors(['openingBalance', 'closingBalance']);
    }
  }

  function onFileChange(f: File | null) {
    setFile(f);
    setFileError(f ? checkCsvFile(f) : null);
  }

  async function onSubmit() {
    setFormError(null);
    if (!file) {
      setFileError('请选择文件');
      return;
    }
    const err = checkCsvFile(file);
    if (err) {
      setFileError(err);
      return;
    }

    const values = form.getValues();
    const data = new FormData();
    data.set('accountId', values.accountId);
    data.set('openingBalance', isAnz ? values.openingBalance : '');
    data.set('closingBalance', isAnz ? values.closingBalance : '');
    data.set('file', file);

    // 成功时服务端直接跳到 /import/[batchId]，只有失败才会返回
    onSubmitStart();
    const result = await importCsvAction(data);
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
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" />
              ANZ Plus 和现金账户不能导入 CSV，用“记一笔”手动录入。
            </p>
          </CardContent>
        </Card>

        {/* 2. 上传 CSV ，选了账户才显示 */}
        {selected && (
          <Card>
            <CardHeader>
              <CardTitle>2. 上传 CSV</CardTitle>
              <CardDescription>网银导出的原始 CSV，不超过 1 MB。文件本身不会保存</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Input
                type="file"
                accept=".csv,text/csv"
                aria-label="CSV 文件"
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

        {/* 3. 对账（ANZ 可选；CBA 从余额列自动算） */}
        {selected && (
          <Card>
            <CardHeader>
              <CardTitle>
                3. 对账 <span className="text-sm font-normal text-muted-foreground">（可选）</span>
              </CardTitle>
              <CardDescription>
                {isAnz
                  ? '可以参考 PDF 对账单填期初和期末余额，检查有没有漏导或重复。不填也能导入'
                  : 'CBA 的 CSV 带余额列，期初期末会自动算出来，不用填'}
              </CardDescription>
            </CardHeader>
            {isAnz && (
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
