// M13-6 第 11 条：流水的商家列只显示商家名，脱敏后的原始描述（R2.3）放 title 悬停
// 两者去掉大小写、空格后一样时，悬停也是重复的，不加
// 纯函数，不 import 数据库和 Next.js

const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();

export function rawDescriptionTitle(rawDescription: string, merchant: string): string | undefined {
  return normalize(rawDescription) === normalize(merchant) ? undefined : rawDescription;
}
