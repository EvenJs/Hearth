// R7 分类（business-rules.md R7、R7.1）
// 纯函数，不 import 数据库和 Next.js
import type { Category, CategoryRule, CategorySource, SystemCategoryKey } from './types';

export type ClassifyInput = {
  merchant: string; // R3 清洗后的 merchant
  isInternalTransfer: boolean; // R6.1 已经认成内部转账（transfer_status = auto）
};

export type ClassifyResult = {
  categoryId: string;
  categorySource: CategorySource;
  isPreTax: boolean; // R7：等于分类的 isPreTaxDefault
};

// R7 第 2 步：硬编码的系统规则，不在 category_rule 表里
// 其他银行费用（信用卡利息等）拿到对应 CSV 后再加，不提前猜
function matchSystemRule(merchant: string): SystemCategoryKey | null {
  const m = merchant.toUpperCase();
  if (m.startsWith('ATM')) return 'cash_withdrawal';
  if (m.includes('ACCOUNT SERVICING FEE')) return 'bank_fee'; // 包括 REVERSAL OF
  return null;
}

function ruleMatches(merchant: string, rule: CategoryRule): boolean {
  const keyword = rule.keyword.toUpperCase();
  return rule.matchType === 'starts_with'
    ? merchant.startsWith(keyword)
    : merchant.includes(keyword);
}

// R7 第 3 步：多条命中时 priority 大的优先 → 关键词长的优先 → 创建时间早的优先
// is_system（预置规则）不影响排序
function compareRules(a: CategoryRule, b: CategoryRule): number {
  return (
    b.priority - a.priority ||
    b.keyword.length - a.keyword.length ||
    a.createdAt.getTime() - b.createdAt.getTime()
  );
}

// R7 第 3 步：对 merchant 做匹配，不区分大小写。没命中 → null
export function matchRule(merchant: string, rules: readonly CategoryRule[]): CategoryRule | null {
  const m = merchant.toUpperCase();
  const hits = rules.filter((r) => ruleMatches(m, r));
  if (hits.length === 0) return null;
  return hits.reduce((best, r) => (compareRules(r, best) < 0 ? r : best));
}

function byId(categories: readonly Category[], id: string): Category {
  const c = categories.find((x) => x.id === id);
  if (!c) throw new Error(`分类不存在: ${id}`);
  return c;
}

function bySystemKey(categories: readonly Category[], key: SystemCategoryKey): Category {
  const c = categories.find((x) => x.systemKey === key);
  if (!c) throw new Error(`系统分类不存在: ${key}`);
  return c;
}

function result(category: Category, categorySource: CategorySource): ClassifyResult {
  return { categoryId: category.id, categorySource, isPreTax: category.isPreTaxDefault };
}

// R7：按顺序第一个命中的生效。R7.1：正数和负数走同一套规则，所以不需要金额
export function classify(
  input: ClassifyInput,
  rules: readonly CategoryRule[],
  categories: readonly Category[],
): ClassifyResult {
  // 1. R6.1 已标为内部转账
  if (input.isInternalTransfer) {
    return result(bySystemKey(categories, 'internal_transfer'), 'system');
  }

  // 2. 系统规则
  const systemKey = matchSystemRule(input.merchant);
  if (systemKey) return result(bySystemKey(categories, systemKey), 'system');

  // 3. 用户规则
  const rule = matchRule(input.merchant, rules);
  if (rule) return result(byId(categories, rule.categoryId), 'rule');

  // 4. 未分类
  return result(bySystemKey(categories, 'uncategorized'), 'system');
}
