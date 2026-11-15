// R1：按 financial_account.bank 选解析器。cash、other 没有解析器，只能手动录入（R8.1）
// 纯函数，不 import 数据库
import type { Bank } from '@/lib/accounts/account-input';

const CSV_IMPORTABLE_BANKS: readonly Bank[] = ['anz', 'cba'];

// R1C 到 R1G：ANZ、ANZ Plus、CBA、BOQ、Westpac 有 PDF 对账单解析器。ANZ Plus、BOQ、Westpac 只能导对账单
const STATEMENT_IMPORTABLE_BANKS: readonly Bank[] = ['anz', 'anz_plus', 'cba', 'boq', 'westpac'];

// R1
export function canImportCsv(bank: Bank): boolean {
  return CSV_IMPORTABLE_BANKS.includes(bank);
}

// R1C 到 R1G
export function canImportStatement(bank: Bank): boolean {
  return STATEMENT_IMPORTABLE_BANKS.includes(bank);
}
