// CBA CSV 解析器（business-rules.md R1B、R1B.1、R1B.2）
// 没有表头，4 列：日期、金额、描述、余额，全部带引号。金额和余额带 +/-
// 纯函数，不 import 数据库和 Next.js
import { parseAmountToCents, parseBalanceToCents } from '@/lib/rules/money';
import { parseAuDate } from '@/lib/rules/date';
import type { ParsedRow } from '@/lib/rules/types';
import { atLine, CsvRowError, readCsvLines } from './csv';

// R1B：任意一行出错抛 CsvRowError（带行号），不返回任何一行
export function parseCbaCsv(text: string): ParsedRow[] {
  return readCsvLines(text).map(({ line, fields }) => {
    if (fields.length !== 4) {
      throw new CsvRowError(
        line,
        `应该有 4 列（日期、金额、描述、余额），实际 ${fields.length} 列`,
      );
    }

    const [rawDate, rawAmount, rawDescription, rawBalance] = fields;
    const description = rawDescription.trim(); // R1.0-5 只去首尾空白
    if (description === '') throw new CsvRowError(line, '描述为空');

    return {
      date: atLine(line, () => parseAuDate(rawDate)), // R1.0-3
      amountCents: atLine(line, () => parseAmountToCents(rawAmount)), // R1.0-4
      description,
      balanceCents: atLine(line, () => parseBalanceToCents(rawBalance)),
      rowIndex: line,
    };
  });
}

export type BalanceWarning = {
  line: number; // 较新的一行
  nextLine: number; // 紧挨着的较旧的一行
  message: string;
};

function requireBalance(row: ParsedRow): number {
  if (row.balanceCents === null) throw new Error(`第 ${row.rowIndex} 行没有余额`);
  return row.balanceCents;
}

// R1B.1：文件顺序新的在前，balance[i] − amount[i] == balance[i+1]
// 不成立只记警告，不报错
export function checkBalanceContinuity(rows: ParsedRow[]): BalanceWarning[] {
  const warnings: BalanceWarning[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const cur = rows[i];
    const next = rows[i + 1];
    if (requireBalance(cur) - cur.amountCents !== requireBalance(next)) {
      warnings.push({
        line: cur.rowIndex,
        nextLine: next.rowIndex,
        message: `第 ${cur.rowIndex} 行和第 ${next.rowIndex} 行之间余额不连续`,
      });
    }
  }
  return warnings;
}

// R1B.2：期末 = 第一行（最新）的余额；期初 = 最后一行（最旧）的余额 − 最后一行的金额
export function deriveBalances(rows: ParsedRow[]): {
  openingBalanceCents: number;
  closingBalanceCents: number;
} {
  const first = rows.at(0);
  const last = rows.at(-1);
  if (!first || !last) throw new Error('没有交易，算不出期初期末余额');
  return {
    openingBalanceCents: requireBalance(last) - last.amountCents,
    closingBalanceCents: requireBalance(first),
  };
}
