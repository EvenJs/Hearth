// M2 规则函数共用的类型（business-rules.md R1–R7）
// 普通 TypeScript 类型，不用 Drizzle 生成的类型；不 import 数据库和 Next.js
// 枚举值和 src/db/schema.ts 保持一致（types.test.ts 检查）
import type { AccountType, Bank } from '@/lib/accounts/account-input';

export type { AccountType, Bank };

// ---------- 枚举 ----------

export const MEMBER_KINDS = ['person', 'shared', 'child'] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

export const CATEGORY_KINDS = ['expense', 'income', 'system'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const SYSTEM_CATEGORY_KEYS = [
  'internal_transfer',
  'cash_withdrawal',
  'bank_fee',
  'uncategorized',
] as const;
export type SystemCategoryKey = (typeof SYSTEM_CATEGORY_KEYS)[number];

export const RULE_MATCH_TYPES = ['contains', 'starts_with'] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

export const TRANSFER_STATUSES = ['none', 'auto', 'suggested', 'confirmed'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

// transaction_split.category_source（R7）：1、2 → system，3 → rule，手动 → manual
export const CATEGORY_SOURCES = ['rule', 'manual', 'system'] as const;
export type CategorySource = (typeof CATEGORY_SOURCES)[number];

// transaction_split.member_source（R5），按优先级从高到低
export const MEMBER_SOURCES = ['manual', 'category', 'card', 'account'] as const;
export type MemberSource = (typeof MEMBER_SOURCES)[number];

// ---------- 家庭配置 ----------

export type Member = {
  id: string;
  name: string;
  kind: MemberKind;
};

// financial_account
export type Account = {
  id: string;
  name: string;
  bank: Bank;
  type: AccountType;
  defaultMemberId: string;
  numberSuffix: string | null; // 4 到 6 位数字，R6.1 用；现金账户为空
};

// card：(accountId, last4) → 归属人，R5 第 3 优先级
export type Card = {
  id: string;
  accountId: string;
  last4: string;
  memberId: string;
};

export type Category = {
  id: string;
  parentId: string | null; // null = 一级
  nameEn: string;
  kind: CategoryKind; // 二级和一级相同
  systemKey: SystemCategoryKey | null; // 只有系统分类有
  defaultMemberId: string | null; // 二级为空时继承一级（R5）
  isPreTaxDefault: boolean; // R7 is_pre_tax
  isOther: boolean;
};

export type CategoryRule = {
  id: string;
  keyword: string; // 大写
  matchType: RuleMatchType;
  categoryId: string;
  priority: number; // 越大越优先
  isSystem: boolean;
  createdAt: Date; // R7 第三个排序条件：创建早的优先
};

// ---------- 导入流水 ----------

// R1 解析结果，一行 CSV 一个
export type ParsedRow = {
  date: string; // YYYY-MM-DD，不转 JS Date
  amountCents: number; // 整数分，≠ 0
  description: string; // 去首尾空白，中间原样，未脱敏
  balanceCents: number | null; // CBA 有，ANZ 为 null
  rowIndex: number; // 文件里的行号，从 1 开始，用于报错和 R1B.1 警告
};

// R2–R7、R5 处理后的一行，对应 transaction + 主拆分
// 不带未脱敏的 description，也不带 R2.2 提取的对方账号（只在内存里用，不入库）
export type ProcessedRow = {
  accountId: string;
  date: string;
  amountCents: number;
  balanceCents: number | null;
  rowIndex: number;

  rawDescription: string; // R2.3 脱敏后的原始描述
  merchant: string; // R3
  cardLast4: string | null; // R2.1

  occurrence: number; // R4.1，从 1 开始
  dedupeKey: string; // R4.1

  transferStatus: TransferStatus; // R6.1 导入时只会是 none 或 auto
  transferAccountId: string | null; // R6.1 匹配到的对方账户，R6.2 配对用

  categoryId: string; // R7
  categorySource: CategorySource;
  isPreTax: boolean; // R7，等于分类的 isPreTaxDefault

  memberId: string; // R5
  memberSource: MemberSource;
};
