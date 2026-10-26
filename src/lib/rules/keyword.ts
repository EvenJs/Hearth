// R13：从手动改分类生成规则时，建议的关键词
// 纯函数，不 import 数据库和 Next.js

const DIGITS_ONLY = /^\d+$/;

// 取 merchant 里第一个纯数字词（门店号）之前的部分；没有数字词就取整个 merchant
// COLES 0559 MELBOURNE → COLES；KIS HAIR MELBOURNE → KIS HAIR MELBOURNE
// 第一个词就是数字时前面是空的，关键词不能为空，取整个 merchant
export function suggestKeyword(merchant: string): string {
  const words = merchant.trim().split(/\s+/).filter(Boolean);
  const firstNumber = words.findIndex((w) => DIGITS_ONLY.test(w));
  const kept = firstNumber > 0 ? words.slice(0, firstNumber) : words;
  return kept.join(' ');
}

// R13、R18.2：保存规则时关键词去首尾空格、多个空格合成一个、转大写
// R7 规则匹配不区分大小写，关键词存大写；merchant 经过 R3 清洗也是单空格
export function normalizeKeyword(keyword: string): string {
  return keyword.trim().replace(/\s+/g, ' ').toUpperCase();
}
