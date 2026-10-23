// ANZ 和 CBA 解析器共用的 CSV 读取（business-rules.md R1.0）
// 纯函数，不 import 数据库和 Next.js
import Papa from 'papaparse';

// R1.0-6：某一行出错，带上行号，整个文件失败
export class CsvRowError extends Error {
  constructor(
    readonly line: number,
    reason: string,
  ) {
    super(`第 ${line} 行：${reason}`);
    this.name = 'CsvRowError';
  }
}

export type CsvLine = {
  line: number; // 文件里的行号，从 1 开始
  fields: string[];
};

// R1.0-1、R1.0-2：用 Papa Parse 读，兼容带引号和不带引号的列、CRLF 和 LF
// 跳过空行和只有空白的行，但行号按原文件算
// 银行导出的字段里不会有换行，所以 Papa 的第 i 行就是文件第 i + 1 行
export function readCsvLines(text: string): CsvLine[] {
  const result = Papa.parse<string[]>(text, {
    delimiter: ',',
    header: false,
    skipEmptyLines: false,
  });

  const [first] = result.errors;
  if (first) {
    throw new CsvRowError((first.row ?? 0) + 1, `CSV 格式不对（${first.message}）`);
  }

  return result.data
    .map((fields, i) => ({ line: i + 1, fields }))
    .filter(({ fields }) => fields.some((f) => f.trim() !== ''));
}

// 把规则函数（parseAuDate、parseAmountToCents）抛的错包上行号
export function atLine<T>(line: number, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CsvRowError) throw error;
    throw new CsvRowError(line, error instanceof Error ? error.message : String(error));
  }
}
