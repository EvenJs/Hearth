// 测试用的家庭配置：照 fixtures/README.md "测试用的家庭配置" 建的内存对象
// 分类和规则从 src/lib/seed/data.ts 生成，和 seed 脚本的结构一致
// id 是可读的假 id（如 'member:Male'），测试失败时好认
import {
  SEED_CATEGORIES,
  SEED_MEMBERS,
  SEED_RULE_DEFAULTS,
  SEED_RULES,
  SEED_SYSTEM_CATEGORIES,
} from '@/lib/seed/data';
import type {
  Account,
  AccountType,
  Bank,
  Card,
  Category,
  CategoryRule,
  Member,
  SystemCategoryKey,
} from '@/lib/rules/types';

export type TestHousehold = {
  members: Member[];
  accounts: Account[];
  cards: Card[];
  categories: Category[];
  rules: CategoryRule[];
  // 按名字找，找不到直接抛错
  member: (name: string) => Member;
  account: (name: string) => Account;
  // 'Groceries / Supermarket' 或一级 'Groceries'
  category: (path: string) => Category;
  systemCategory: (key: SystemCategoryKey) => Category;
};

const ACCOUNT_DEFS: [
  name: string,
  bank: Bank,
  type: AccountType,
  member: string,
  suffix: string,
][] = [
  ['ANZ Joint', 'anz', 'joint', 'Home', '0001'],
  ['ANZ Male', 'anz', 'everyday', 'Male', '0002'],
  ['CBA Female', 'cba', 'everyday', 'Female', '0003'],
  ['CBA Female Saver', 'cba', 'savings', 'Female', '7777'],
  ['ANZ Plus Male', 'anz_plus', 'savings', 'Male', '0004'],
];

// 都在 ANZ Joint 上
const CARD_DEFS: [last4: string, member: string][] = [
  ['1111', 'Male'],
  ['2222', 'Female'],
];

// 规则的 createdAt：seed 一次插入，这里按 SEED_RULES 顺序每条加 1 秒，保证顺序确定
const RULES_CREATED_AT = Date.UTC(2026, 0, 1);

function find<T>(items: T[], pred: (t: T) => boolean, what: string): T {
  const found = items.find(pred);
  if (!found) throw new Error(`测试家庭里没有${what}`);
  return found;
}

export function buildTestHousehold(): TestHousehold {
  const members: Member[] = SEED_MEMBERS.map((m) => ({
    id: `member:${m.name}`,
    name: m.name,
    kind: m.kind,
  }));
  const memberId = (name: string) => find(members, (m) => m.name === name, `归属人 ${name}`).id;

  const accounts: Account[] = ACCOUNT_DEFS.map(([name, bank, type, member, suffix]) => ({
    id: `account:${name}`,
    name,
    bank,
    type,
    defaultMemberId: memberId(member),
    numberSuffix: suffix,
  }));

  const joint = find(accounts, (a) => a.name === 'ANZ Joint', '账户 ANZ Joint');
  const cards: Card[] = CARD_DEFS.map(([last4, member]) => ({
    id: `card:${joint.name}:${last4}`,
    accountId: joint.id,
    last4,
    memberId: memberId(member),
  }));

  // 一级、二级（默认归属人只设在一级，二级继承）、系统分类，顺序和 seed 脚本一致
  const categories: Category[] = [];
  for (const c of SEED_CATEGORIES) {
    const topId = `category:${c.nameEn}`;
    categories.push({
      id: topId,
      parentId: null,
      nameEn: c.nameEn,
      kind: c.kind,
      systemKey: null,
      defaultMemberId: c.defaultMember ? memberId(c.defaultMember) : null,
      isPreTaxDefault: false,
      isOther: false,
    });
    for (const ch of c.children) {
      categories.push({
        id: `category:${c.nameEn} / ${ch.nameEn}`,
        parentId: topId,
        nameEn: ch.nameEn,
        kind: c.kind,
        systemKey: null,
        defaultMemberId: null,
        isPreTaxDefault: ch.isPreTaxDefault,
        isOther: ch.isOther,
      });
    }
  }
  for (const s of SEED_SYSTEM_CATEGORIES) {
    categories.push({
      id: `category:${s.nameEn}`,
      parentId: null,
      nameEn: s.nameEn,
      kind: 'system',
      systemKey: s.systemKey,
      defaultMemberId: null,
      isPreTaxDefault: false,
      isOther: false,
    });
  }

  const category = (path: string) =>
    find(categories, (c) => c.id === `category:${path}`, `分类 ${path}`);

  const rules: CategoryRule[] = SEED_RULES.map((r, i) => ({
    id: `rule:${r.keyword}`,
    keyword: r.keyword,
    matchType: SEED_RULE_DEFAULTS.matchType,
    categoryId: category(`${r.category} / ${r.subcategory}`).id,
    priority: SEED_RULE_DEFAULTS.priority,
    isSystem: SEED_RULE_DEFAULTS.isSystem,
    createdAt: new Date(RULES_CREATED_AT + i * 1000),
  }));

  return {
    members,
    accounts,
    cards,
    categories,
    rules,
    member: (name) => find(members, (m) => m.name === name, `归属人 ${name}`),
    account: (name) => find(accounts, (a) => a.name === name, `账户 ${name}`),
    category,
    systemCategory: (key) => find(categories, (c) => c.systemKey === key, `系统分类 ${key}`),
  };
}
