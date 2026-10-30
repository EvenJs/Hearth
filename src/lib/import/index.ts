// R1：按 financial_account.bank 选解析器的入口。CSV（R1A、R1B）和 PDF 对账单（R1C、R1D）
// 返回结果对象，不抛错，Server Action 可以直接把 message 显示出来
// 纯函数，不 import 数据库和 Next.js
import { addDays } from '@/lib/rules/periods';
import type { Bank, ParsedRow } from '@/lib/rules/types';
import { parseAnzCsv } from './anz';
import {
  identifyAnzPlusStatementAccount,
  looksLikeAnzPlusStatement,
  parseAnzPlusStatement,
} from './anz-plus-statement';
import {
  identifyStatementAccount,
  parseAnzStatement,
  statementPeriod as anzStatementPeriod,
  type StatementLine,
} from './anz-statement';
import { canImportCsv, canImportStatement } from './banks';
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

// ---------- PDF 对账单 ----------

type StatementBank = 'anz' | 'anz_plus';

// R1D 认格式：两条都满足用 R1D，否则交给 R1C
export function statementBank(lines: readonly StatementLine[]): StatementBank {
  return looksLikeAnzPlusStatement(lines) ? 'anz_plus' : 'anz';
}

// R1C、R1D 自动认账户：accounts 是本家庭没归档的账户，只在和对账单同一家银行的里面找（ANZ 和 ANZ Plus 不混着找）
export function identifyBankStatement(
  lines: readonly StatementLine[],
  accounts: readonly { id: string; bank: Bank; numberSuffix: string | null }[],
): { ok: true; accountId: string } | { ok: false; message: string } {
  const bank = statementBank(lines);
  const candidates = accounts.filter((a) => a.bank === bank);
  return bank === 'anz_plus'
    ? identifyAnzPlusStatementAccount(lines, candidates)
    : identifyStatementAccount(lines, candidates);
}

export type ParseStatementResult =
  | {
      ok: true;
      rows: ParsedRow[]; // 旧的在前
      dateFrom: string; // import_batch.date_from：R1C 是账期开始日的第二天，R1D 是账期开始日
      dateTo: string;
      openingCents: number;
      closingCents: number;
    }
  | { ok: false; message: string; page: number | null; index: number | null };

// R1：按账户的 bank 选对账单解析器。账号尾号核对在解析器里做
export function parseBankStatement(
  bank: Bank,
  lines: readonly StatementLine[],
  accountSuffix: string | null,
): ParseStatementResult {
  if (!canImportStatement(bank)) {
    return { ok: false, message: '这个账户不能导入 PDF 对账单', page: null, index: null };
  }

  if (bank === 'anz_plus') {
    // R1D：账期是闭区间 [periodFrom, periodTo]，date_from 不加一天
    const r = parseAnzPlusStatement(lines, accountSuffix);
    if (!r.ok) return r;
    return {
      ok: true,
      rows: r.rows,
      dateFrom: r.periodFrom,
      dateTo: r.periodTo,
      openingCents: r.openingCents,
      closingCents: r.closingCents,
    };
  }

  // R1C：账期是 (periodFrom, periodTo]，R9 照旧按 [date_from, date_to] 算
  const r = parseAnzStatement(lines, accountSuffix);
  if (!r.ok) return r;
  return {
    ok: true,
    rows: r.rows,
    dateFrom: addDays(r.periodFrom, 1),
    dateTo: r.periodTo,
    openingCents: r.openingCents,
    closingCents: r.closingCents,
  };
}

// 页面显示纸面对账单印的账期：R1C 的 date_from 是开始日的第二天，减回去；R1D 存的就是开始日
export function statementPeriod(
  bank: Bank,
  dateFrom: string,
  dateTo: string,
): { from: string; to: string } {
  return bank === 'anz_plus' ? { from: dateFrom, to: dateTo } : anzStatementPeriod(dateFrom, dateTo);
}
