// R1：按 financial_account.bank 选解析器的入口
// 返回结果对象，不抛错，Server Action 可以直接把 message 显示出来
// 纯函数，不 import 数据库和 Next.js
import type { Bank, ParsedRow } from '@/lib/rules/types';
import { parseAnzCsv } from './anz';
import { canImportCsv } from './banks';
import { parseCbaCsv } from './cba';
import { CsvRowError } from './csv';

export type ParseCsvResult =
  { ok: true; rows: ParsedRow[] } | { ok: false; message: string; line: number | null };

const PARSERS: Partial<Record<Bank, (text: string) => ParsedRow[]>> = {
  anz: parseAnzCsv,
  cba: parseCbaCsv,
};

export function parseBankCsv(bank: Bank, text: string): ParseCsvResult {
  // R1、R8.1：anz_plus、cash、other 只能手动录入
  if (!canImportCsv(bank)) {
    return { ok: false, message: '这个账户不能导入 CSV', line: null };
  }

  const parse = PARSERS[bank];
  if (!parse) return { ok: false, message: '这家银行的解析器还没做', line: null };

  try {
    const rows = parse(text);
    if (rows.length === 0) return { ok: false, message: '文件里没有交易', line: null };
    return { ok: true, rows };
  } catch (error) {
    // R1.0-6：任意一行出错，整个文件失败
    if (error instanceof CsvRowError) {
      return { ok: false, message: error.message, line: error.line };
    }
    throw error;
  }
}
