// M3-7 导入页的表单校验。前端表单和 Server Action 共用
// 纯函数，不 import 数据库和 Next.js
import { z } from 'zod';
import { parseBalanceToCents } from '@/lib/rules/money';

// 半年流水远远够
export const MAX_CSV_BYTES = 1024 * 1024;

// ANZ 对账单（R1C，M6.6-4）。Server Action 请求体上限 2 MB（next.config.ts），留余量给表单字段
export const MAX_PDF_BYTES = 1.5 * 1024 * 1024;

// 余额输入框：单位是元。空 → null；允许从 PDF 对账单抄来的 $ 和千分位逗号，可以是 0 或负数
// 去掉 $、逗号、空格后按 R1.0-4 的规则转成整数分，格式不对抛错
export function parseBalanceInput(input: string): number | null {
  const s = input.replace(/[\s$,]/g, '');
  if (s === '' && input.trim() === '') return null;
  return parseBalanceToCents(s);
}

const BALANCE_FORMAT = '金额格式不对，例如 14,195.10';
const BALANCE_PAIR = '期初和期末要一起填，或者都不填';

const balance = z.string().superRefine((v, ctx) => {
  try {
    parseBalanceInput(v);
  } catch {
    ctx.addIssue({ code: 'custom', message: BALANCE_FORMAT });
  }
});

// accountId 之外两个余额都是字符串（输入框原样），输出整数分或 null
// 账户是不是 ANZ 由服务端按账户判断，CBA 的余额 importCsv 会忽略（R1B.2 自动得出）
export const importFormSchema = z
  .object({
    accountId: z.uuid('请选择账户'),
    openingBalance: balance,
    closingBalance: balance,
  })
  .superRefine((v, ctx) => {
    const opening = v.openingBalance.trim() === '';
    const closing = v.closingBalance.trim() === '';
    if (opening && !closing)
      ctx.addIssue({ code: 'custom', path: ['openingBalance'], message: BALANCE_PAIR });
    if (closing && !opening)
      ctx.addIssue({ code: 'custom', path: ['closingBalance'], message: BALANCE_PAIR });
  })
  .transform((v) => ({
    accountId: v.accountId,
    openingBalanceCents: parseBalanceInput(v.openingBalance),
    closingBalanceCents: parseBalanceInput(v.closingBalance),
  }));

export type ImportFormInput = z.input<typeof importFormSchema>;
export type ImportFormValues = z.output<typeof importFormSchema>;

// 文件检查：只要 .csv、不超过 1 MB、不是空文件。返回错误信息，没问题返回 null
export function checkCsvFile(file: { name: string; size: number }): string | null {
  if (!/.\.csv$/i.test(file.name)) return '只支持 .csv 文件';
  if (file.size === 0) return '文件是空的';
  if (file.size > MAX_CSV_BYTES) return '文件不能超过 1 MB';
  return null;
}

// ANZ 对账单（R1C）的文件检查：只要 .pdf、不超过 1.5 MB、不是空文件。返回错误信息，没问题返回 null
export function checkPdfFile(file: { name: string; size: number }): string | null {
  if (!/.\.pdf$/i.test(file.name)) return '只支持 .pdf 文件';
  if (file.size === 0) return '文件是空的';
  if (file.size > MAX_PDF_BYTES) return '文件不能超过 1.5 MB';
  return null;
}
