// 设置 → 规则（business-rules.md R18）：命中数、新建和修改的检查、列表筛选
// R18.4 重新应用不在这里，直接用 split-edit.ts 的 planReapply
// 纯函数，不 import 数据库和 Next.js
import { matchRule, matchSystemRule } from './classify';
import { normalizeKeyword } from './keyword';
import { isSelectableCategory, type EditCategory } from './split-edit';
import type { Category, CategoryRule, RuleMatchType, TransferStatus } from './types';

export const RULE_KEYWORD_MAX = 100; // R13、R18.2

// ---------- R18.1 命中数 ----------

// 只看 merchant 和转账状态，不管现在的分类和来源。ReapplyTx 也能直接传进来
export type HitTx = {
  merchant: string;
  transferStatus: TransferStatus;
};

// R18.1：每笔交易如果现在重跑 R7，在第 3 步胜出的那条规则计 1
// 内部转账（auto、confirmed）是 R7 第 1 步，命中系统规则是第 2 步，都走不到第 3 步，不算
// 返回每条规则的命中数，没命中的是 0
export function ruleHits(
  txs: readonly HitTx[],
  rules: readonly CategoryRule[],
): Map<string, number> {
  const hits = new Map<string, number>(rules.map((r) => [r.id, 0]));
  for (const tx of txs) {
    if (tx.transferStatus === 'auto' || tx.transferStatus === 'confirmed') continue; // R7 第 1 步
    if (matchSystemRule(tx.merchant)) continue; // R7 第 2 步
    const winner = matchRule(tx.merchant, rules); // R7 第 3 步
    if (winner) hits.set(winner.id, (hits.get(winner.id) ?? 0) + 1);
  }
  return hits;
}

// ---------- R18.2 新建和修改 ----------

export type RuleEditInput = {
  keyword: string; // 用户输入的，还没规范化
  matchType: RuleMatchType;
  categoryId: string;
};

export type RuleEditResult =
  | { ok: true; value: RuleEditInput } // keyword 已经规范化
  // conflictRuleId：撞了的那条规则，UI 可以带过去让用户改它
  | { ok: false; message: string; conflictRuleId?: string };

// 分类显示名：二级带上一级，"Groceries / Supermarket"
function categoryLabel(c: Category, categories: readonly Category[]): string {
  if (c.parentId === null) return c.nameEn;
  const parent = categories.find((p) => p.id === c.parentId);
  return parent ? `${parent.nameEn} / ${c.nameEn}` : c.nameEn;
}

// R16.3：内部转账、归档的不能选；一级归档后下面的二级也不能选（2026-10-24 补）
function selectable(c: EditCategory, categories: readonly EditCategory[]): boolean {
  if (!isSelectableCategory(c)) return false;
  if (c.parentId === null) return true;
  const parent = categories.find((p) => p.id === c.parentId);
  return parent ? !parent.isArchived : true;
}

// R18.2：关键词按 R13 规范化（不能为空，最长 100）；分类按 R16.3；
// (keyword, match_type) 和别的规则撞了报错"已有规则 X → Y"，不合并（不走 R16.6 的覆盖）
// selfId：修改时传自己的 id，自己这条不算撞
export function checkRuleEdit(
  input: RuleEditInput,
  rules: readonly CategoryRule[],
  categories: readonly EditCategory[],
  selfId?: string,
): RuleEditResult {
  const keyword = normalizeKeyword(input.keyword);
  if (keyword.length === 0) return { ok: false, message: '关键词不能为空' };
  if (keyword.length > RULE_KEYWORD_MAX) {
    return { ok: false, message: `关键词最长 ${RULE_KEYWORD_MAX} 个字符` };
  }

  const category = categories.find((c) => c.id === input.categoryId);
  if (!category || !selectable(category, categories)) {
    return { ok: false, message: '不能选这个分类' };
  }

  // 存的关键词都是大写，这里再转一次，防止旧数据大小写不一致
  const clash = rules.find(
    (r) =>
      r.id !== selfId && r.matchType === input.matchType && r.keyword.toUpperCase() === keyword,
  );
  if (clash) {
    const target = categories.find((c) => c.id === clash.categoryId);
    const label = target ? categoryLabel(target, categories) : clash.categoryId;
    return {
      ok: false,
      message: `已有规则 ${clash.keyword} → ${label}`,
      conflictRuleId: clash.id,
    };
  }

  return { ok: true, value: { keyword, matchType: input.matchType, categoryId: input.categoryId } };
}

// ---------- R18.1 列表筛选 ----------

export type RuleFilter = {
  search?: string; // 关键词包含，不区分大小写
  topCategoryId?: string; // 一级 id：指向它本身和它所有二级的规则
};

type FilterableRule = Pick<CategoryRule, 'keyword' | 'matchType' | 'categoryId'>;

// 关键词相同（包含 / 开头是各一条）时 contains 在前，保证顺序确定
const MATCH_TYPE_ORDER: Record<RuleMatchType, number> = { contains: 0, starts_with: 1 };

function compareKeyword(a: FilterableRule, b: FilterableRule): number {
  if (a.keyword !== b.keyword) return a.keyword < b.keyword ? -1 : 1;
  return MATCH_TYPE_ORDER[a.matchType] - MATCH_TYPE_ORDER[b.matchType];
}

// R18.1：按关键词字母排序；搜索和一级筛选可以一起用。不改输入数组
export function filterRules<T extends FilterableRule>(
  rules: readonly T[],
  filter: RuleFilter,
  categories: readonly Category[],
): T[] {
  const search = filter.search?.trim().toUpperCase() ?? '';
  const top = filter.topCategoryId;
  const inTop = top
    ? new Set(categories.filter((c) => c.id === top || c.parentId === top).map((c) => c.id))
    : null;

  return rules
    .filter((r) => (search ? r.keyword.toUpperCase().includes(search) : true))
    .filter((r) => (inTop ? inTop.has(r.categoryId) : true))
    .sort(compareKeyword);
}
