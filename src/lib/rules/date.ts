// 日期工具（business-rules.md R1.0-3）
// 交易日期是 YYYY-MM-DD 字符串，不转成 JS Date（避免时区把日期挪一天）
// 纯函数，不 import 数据库和 Next.js

// 银行导出都是两位日、两位月、四位年
const AU_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// R1.0-3："29/09/2026" → "2026-09-29"。格式不对或日期不存在（31/02）时抛错
export function parseAuDate(input: string): string {
  const m = AU_DATE.exec(input.trim());
  if (!m) throw new Error(`日期格式不对，应为 DD/MM/YYYY: "${input}"`);

  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`日期不存在: "${input}"`);
  }

  return `${yyyy}-${mm}-${dd}`;
}
