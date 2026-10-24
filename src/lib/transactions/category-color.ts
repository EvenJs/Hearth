// 分类 tag 的颜色（design/README 第 3 节，2026-10-24）
// 每个一级一个色系，二级用所属一级的色系（浅一点，由显示的地方决定）
// 未分类琥珀色、系统分类（内部转账、现金支出、银行费用）灰色；一级不用琥珀色和蓝色（建议转账）
// 颜色不存数据库：seed 的一级按名字固定，自己新建的按 id 固定挑一个
// 纯函数，不 import 数据库和 Next.js

// 一级能用的色系（Tailwind 颜色名），显示的地方按这个名字取 class
export const CATEGORY_COLORS = [
  'orange',
  'indigo',
  'teal',
  'pink',
  'violet',
  'lime',
  'green',
  'rose',
  'cyan',
  'fuchsia',
  'emerald',
] as const;
export type CategoryColor = (typeof CATEGORY_COLORS)[number];
export type CategoryTone = CategoryColor | 'uncategorized' | 'system';

// docs/seed-categories.md 第 2 节的 6 个支出一级
// 色相尽量拉开：橙、靛蓝、青、紫红、玫红、黄绿，加上收入的绿（2026-10-24 调过一次，原来 Groceries 的青绿和收入太像）
const SEED_EXPENSE: Record<string, CategoryColor> = {
  'Home & utilities': 'orange',
  'Insurance & financial': 'indigo',
  Groceries: 'cyan',
  'Personal & medical': 'fuchsia',
  'Entertainment & eat-out': 'rose',
  'Transport & auto': 'lime',
};

// 自己新建的支出一级从这里挑（不和 seed、收入撞色）
const EXTRA: readonly CategoryColor[] = ['violet', 'teal', 'pink', 'emerald'];

// 字符串 → 非负整数，同一个输入每次一样
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function categoryColor(top: {
  topId: string;
  topName: string;
  kind: 'expense' | 'income' | 'system';
  systemKey: string | null;
}): CategoryTone {
  if (top.kind === 'system') return top.systemKey === 'uncategorized' ? 'uncategorized' : 'system';
  if (top.kind === 'income') return 'green';
  return SEED_EXPENSE[top.topName] ?? EXTRA[hash(top.topId) % EXTRA.length];
}
