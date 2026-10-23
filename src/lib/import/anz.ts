// ANZ CSV 解析器（business-rules.md R1A）
// 没有表头，3 列：日期、金额（带引号）、描述（不带引号）。没有余额
// 纯函数，不 import 数据库和 Next.js
import { parseAmountToCents } from '@/lib/rules/money';
import { parseAuDate } from '@/lib/rules/date';
import type { ParsedRow } from '@/lib/rules/types';
import { atLine, CsvRowError, readCsvLines } from './csv';

// R1A：任意一行出错抛 CsvRowError（带行号），不返回任何一行
export function parseAnzCsv(text: string): ParsedRow[] {
  return readCsvLines(text).map(({ line, fields }) => {
    if (fields.length < 3) {
      throw new CsvRowError(line, `应该有 3 列（日期、金额、描述），实际 ${fields.length} 列`);
    }

    const [rawDate, rawAmount, ...rest] = fields;
    // R1A：描述不带引号，里面的逗号会被切开，拼回去
    const description = rest.join(',').trim(); // R1.0-5 只去首尾空白
    if (description === '') throw new CsvRowError(line, '描述为空');

    return {
      date: atLine(line, () => parseAuDate(rawDate)), // R1.0-3
      amountCents: atLine(line, () => parseAmountToCents(rawAmount)), // R1.0-4
      description,
      balanceCents: null,
      rowIndex: line,
    };
  });
}
