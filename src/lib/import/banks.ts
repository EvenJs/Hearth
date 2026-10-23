// R1：按 financial_account.bank 选解析器。anz_plus、cash、other 没有解析器，只能手动录入（R8.1）
// 纯函数，不 import 数据库
import type { Bank } from '@/lib/accounts/account-input';

const CSV_IMPORTABLE_BANKS: readonly Bank[] = ['anz', 'cba'];

// R1
export function canImportCsv(bank: Bank): boolean {
  return CSV_IMPORTABLE_BANKS.includes(bank);
}
