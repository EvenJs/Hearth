'use server';

// F2 CSV 导入的 Server Action（M3-7）。输入用 Zod 再校验一次，前端校验可以被绕过
// 不保存上传的原文件；日志里不打印文件内容和数据库错误详情（参数里可能有交易描述）
import { redirect } from 'next/navigation';
import { checkCsvFile, importFormSchema } from '@/lib/import/import-input';
import { getHouseholdContext } from '@/server/context';
import { importCsv, type ImportResult } from '@/server/imports';

export type ImportField = 'accountId' | 'openingBalance' | 'closingBalance' | 'file';

export type ImportActionFailure = {
  ok: false;
  message: string;
  fieldErrors?: Partial<Record<ImportField, string>>;
};

const text = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

// 成功时 redirect 到 /import/[batchId]，不返回
export async function importCsvAction(formData: FormData): Promise<ImportActionFailure> {
  const ctx = await getHouseholdContext();

  const fieldErrors: Partial<Record<ImportField, string>> = {};
  const parsed = importFormSchema.safeParse({
    accountId: text(formData.get('accountId')),
    openingBalance: text(formData.get('openingBalance')),
    closingBalance: text(formData.get('closingBalance')),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as ImportField;
      fieldErrors[field] ??= issue.message;
    }
  }
  const file = formData.get('file');
  if (!(file instanceof File)) {
    fieldErrors.file = '请选择文件';
  } else {
    const fileError = checkCsvFile(file);
    if (fileError) fieldErrors.file = fileError;
  }
  if (!parsed.success || !(file instanceof File) || fieldErrors.file) {
    return { ok: false, message: '请检查表单', fieldErrors };
  }

  let result: ImportResult;
  try {
    result = await importCsv(ctx, {
      accountId: parsed.data.accountId,
      fileName: file.name,
      text: await file.text(),
      openingBalanceCents: parsed.data.openingBalanceCents,
      closingBalanceCents: parsed.data.closingBalanceCents,
    });
  } catch (err) {
    // 事务已经回滚，什么都没写入
    console.error('[import] 导入失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '导入失败，请稍后再试' };
  }

  if (!result.ok) {
    // 解析失败的 message 已经带"第 N 行："
    if (result.reason === 'invalid_balance') {
      return {
        ok: false,
        message: result.message,
        fieldErrors: { openingBalance: result.message },
      };
    }
    if (result.reason === 'not_importable') {
      return { ok: false, message: result.message, fieldErrors: { accountId: result.message } };
    }
    return { ok: false, message: result.message };
  }

  redirect(`/import/${result.batchId}`);
}
