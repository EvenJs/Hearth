// 流水页的显示格式。日期是 YYYY-MM-DD 字符串，不转 JS Date
import type { CategoryRef } from '@/server/transactions';

// "2026-09-22" → "9月22日"；不是今年的带上年份 "2025年9月22日"
export function formatTxDate(date: string, today: string): string {
  const [y, m, d] = date.split('-');
  const md = `${Number(m)}月${Number(d)}日`;
  return y === today.slice(0, 4) ? md : `${y}年${md}`;
}

// 分类先显示英文（design/README 第 3 节）；二级带上一级："Groceries / Supermarket"
export function categoryLabel(c: CategoryRef): string {
  return c.parent ? `${c.parent.nameEn} / ${c.nameEn}` : c.nameEn;
}
