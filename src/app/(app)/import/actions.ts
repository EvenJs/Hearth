'use server';

// F2 导入的 Server Action（M3-7；M6.6-6 加 ANZ PDF 对账单）。输入用 Zod 再校验一次，前端校验可以被绕过
// 不保存上传的原文件；日志里不打印文件内容和数据库错误详情（参数里可能有交易描述）
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { ImportCoverage } from '@/lib/import/coverage';
import { checkImportFile, importFormSchema } from '@/lib/import/import-input';
import { getHouseholdContext } from '@/server/context';
import {
  getUndoPreview,
  identifyStatement,
  importCsv,
  importStatement,
  undoImport,
  type ImportResult,
  type UndoPreview,
} from '@/server/imports';

export type ImportField = 'accountId' | 'openingBalance' | 'closingBalance' | 'file';

export type ImportActionFailure = {
  ok: false;
  message: string;
  fieldErrors?: Partial<Record<ImportField, string>>;
};

const text = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

// 成功时 redirect 到 /import/[batchId]，不返回
// 按扩展名分：.pdf 走 ANZ 对账单（R1C：按账号自动认账户，期初期末从汇总页读，不看传来的账户和余额）
// .csv 照旧要选账户
export async function importFileAction(formData: FormData): Promise<ImportActionFailure> {
  const ctx = await getHouseholdContext();

  const file = formData.get('file');
  const checked = file instanceof File ? checkImportFile(file, 'anz') : null;
  const fileError = !checked
    ? '请选择文件'
    : (checked.error ?? (checked.kind === null ? '只支持 .csv 或 .pdf 文件' : null));

  // R1C 自动认账户（M6.6-6b）
  if (file instanceof File && checked?.kind === 'pdf' && !fileError) {
    return runImportAction(async () =>
      importStatement(ctx, {
        fileName: file.name,
        buffer: new Uint8Array(await file.arrayBuffer()),
      }),
    );
  }

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
  if (fileError) fieldErrors.file = fileError;
  if (!parsed.success || !(file instanceof File) || fileError) {
    return { ok: false, message: '请检查表单', fieldErrors };
  }

  return runImportAction(async () =>
    importCsv(ctx, {
      accountId: parsed.data.accountId,
      fileName: file.name,
      text: await file.text(),
      openingBalanceCents: parsed.data.openingBalanceCents,
      closingBalanceCents: parsed.data.closingBalanceCents,
    }),
  );
}

// 跑导入、把失败转成表单错误；成功就跳到结果页
async function runImportAction(run: () => Promise<ImportResult>): Promise<ImportActionFailure> {
  let result: ImportResult;
  try {
    result = await run();
  } catch (err) {
    // 事务已经回滚，什么都没写入
    console.error('[import] 导入失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '导入失败，请稍后再试' };
  }

  if (!result.ok) {
    // 对账单不是 .pdf、太大、是空的
    if (result.reason === 'invalid_file') {
      return { ok: false, message: result.message, fieldErrors: { file: result.message } };
    }
    // 解析失败的 message 已经带"第 N 行："（CSV）或"第 N 页第 M 笔："（对账单）
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

// ==================== R1C 自动认账户（M6.6-6b） ====================

export type IdentifiedAccount = {
  id: string;
  name: string;
  numberSuffix: string | null;
  coverage: ImportCoverage; // R12.2
};

export type IdentifyActionResult =
  { ok: true; account: IdentifiedAccount } | { ok: false; message: string };

// 导入页传了 PDF 以后马上调：读对账单、认账户，什么都不写
export async function identifyStatementAction(formData: FormData): Promise<IdentifyActionResult> {
  const ctx = await getHouseholdContext();
  const file = formData.get('file');
  if (!(file instanceof File)) return { ok: false, message: '请选择文件' };
  try {
    const r = await identifyStatement(ctx, {
      fileName: file.name,
      buffer: new Uint8Array(await file.arrayBuffer()),
    });
    if (!r.ok) return { ok: false, message: r.message };
    return { ok: true, account: { ...r.account, coverage: r.coverage } };
  } catch (err) {
    console.error('[import] 识别对账单失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '读取对账单失败，请稍后再试' };
  }
}

// ==================== R12.1 撤销导入（M3-9） ====================

export type UndoActionResult =
  { ok: true; deletedCount: number; restoredPendingCount: number } | { ok: false; message: string };

const NOT_FOUND = { ok: false, message: '这次导入不存在，可能已经撤销了' } as const;

// 弹窗要显示的笔数。按钮点击时现查，不用页面渲染时的旧数据
export async function previewUndoAction(
  batchId: string,
): Promise<UndoPreview | { ok: false; message: string }> {
  const ctx = await getHouseholdContext();
  const id = z.uuid().safeParse(batchId);
  if (!id.success) return NOT_FOUND;
  try {
    return await getUndoPreview(ctx, id.data);
  } catch (err) {
    console.error('[undo] 读取撤销信息失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '读取失败，请稍后再试' };
  }
}

export async function undoImportAction(batchId: string): Promise<UndoActionResult> {
  const ctx = await getHouseholdContext();
  const id = z.uuid().safeParse(batchId);
  if (!id.success) return NOT_FOUND;
  try {
    const r = await undoImport(ctx, id.data);
    if (!r.ok) return { ok: false, message: r.message };
    revalidatePath('/import/history');
    revalidatePath(`/import/${id.data}`);
    return { ok: true, deletedCount: r.deletedCount, restoredPendingCount: r.restoredPendingCount };
  } catch (err) {
    // 事务已经回滚，什么都没改
    console.error('[undo] 撤销失败', err instanceof Error ? err.name : typeof err);
    return { ok: false, message: '撤销失败，请稍后再试' };
  }
}
