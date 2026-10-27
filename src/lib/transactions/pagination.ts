// F8 分页的跳页框（docs/design/README.md 第 3 节，M5.5-5）
// 纯函数，不 import 数据库和 Next.js

// 用户输入的页码 → 要跳到的页。不是纯数字（ASCII）→ null，不跳；超出范围按 1 或 totalPages
export function parsePageInput(text: string, totalPages: number): number | null {
  const t = text.trim();
  if (!/^[0-9]+$/.test(t)) return null;
  return Math.min(Math.max(Number(t), 1), Math.max(totalPages, 1));
}
