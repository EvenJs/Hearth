// 种子数据：docs/seed-categories.md 的 TypeScript 版本
// 纯数据，不 import 数据库。M1-3 的 seed 脚本和 M2 的测试共用
// 改这里之前先改 seed-categories.md，两边保持一致
// ❓ = 文档里标了"猜的"，导入真实流水后确认

// ---------- 类型 ----------

export type SeedMemberName = 'Male' | 'Female' | 'Home';

export type SeedMember = {
  name: SeedMemberName;
  kind: 'person' | 'shared' | 'child';
};

export type SeedSubcategory = {
  nameEn: string;
  isPreTaxDefault: boolean;
  isOther: boolean;
};

export type SeedCategory = {
  nameEn: string;
  kind: 'expense' | 'income';
  // 一级上的默认归属人，二级继承（R5）；null = 不设，按卡号或账户决定
  defaultMember: SeedMemberName | null;
  // 最后一个是自动生成的 Other
  children: SeedSubcategory[];
};

export type SeedSystemCategory = {
  systemKey: 'internal_transfer' | 'cash_withdrawal' | 'bank_fee' | 'uncategorized';
  nameEn: string;
};

export type SeedRule = {
  keyword: string; // 大写，匹配清洗后的 merchant（R3、R7）
  category: string; // 一级 nameEn
  subcategory: string; // 二级 nameEn
};

// ---------- §1 归属人 ----------

// Kid（child）先不建，有孩子时再加
export const SEED_MEMBERS: SeedMember[] = [
  { name: 'Male', kind: 'person' }, // 我
  { name: 'Female', kind: 'person' }, // 老婆
  { name: 'Home', kind: 'shared' }, // 家庭共同部分
];

// ---------- §2、§3 支出和收入分类 ----------

export const OTHER_NAME = 'Other';

type CategoryDef = {
  nameEn: string;
  kind: SeedCategory['kind'];
  defaultMember: SeedMemberName | null;
  // 字符串 = 普通二级；对象 = 需要标 isPreTaxDefault 的二级。不要写 Other，由 withOther 生成
  children: (string | { nameEn: string; isPreTaxDefault: boolean })[];
};

const CATEGORY_DEFS: CategoryDef[] = [
  {
    nameEn: 'Home & utilities',
    kind: 'expense',
    defaultMember: 'Home',
    children: [
      'Mortgage',
      'Rent',
      'Body corporate fees',
      'Council rates',
      'Furniture & appliances',
      'Renovations & maintenance',
      'Household supplies', // 没有预置规则，主要从超市账单拆出来（F10）
      'Electricity',
      'Water',
      'Internet',
      'Mobile',
    ],
  },
  {
    nameEn: 'Insurance & financial',
    kind: 'expense',
    defaultMember: 'Home',
    children: ['Car insurance', 'Home insurance', 'Personal & life insurance'],
  },
  {
    nameEn: 'Groceries',
    kind: 'expense',
    defaultMember: 'Home',
    // 二级是"店的类型"：在超市买的水果算 Supermarket
    children: ['Supermarket', 'Butcher', 'Fruit', 'Vegetable', 'Pet'],
  },
  {
    nameEn: 'Personal & medical',
    kind: 'expense',
    defaultMember: null,
    children: [
      'Hair & beauty',
      'Cosmetics & toiletries',
      'Medicines & pharmacy',
      'Hobbies',
      'Clothing & shoes',
      'Jewellery & accessories',
      'Education',
      'Computers & gadgets',
    ],
  },
  {
    nameEn: 'Entertainment & eat-out',
    kind: 'expense',
    defaultMember: null,
    children: [
      'Coffee & tea',
      'Bubble tea',
      'Lunches', // 没有预置规则：同一家面馆是不是午饭，从流水看不出来
      'Restaurants',
      'Take-away & snacks',
      'Drinks',
      'Books',
      'Movies & music',
      'Holidays',
      'Celebrations & gifts',
    ],
  },
  {
    nameEn: 'Transport & auto',
    kind: 'expense',
    defaultMember: null,
    children: [
      'Public transport',
      'Petrol / EV charging',
      'Rego & licence',
      'Road tolls & parking',
      'Repairs & maintenance',
      'Fines',
    ],
  },
  {
    // 退款和报销不放收入，冲减原支出分类（R7.1）
    // 交税记在 Income 下面（负数），不算支出
    nameEn: 'Income',
    kind: 'income',
    defaultMember: null,
    children: [
      'Salary', // 进银行时已扣 PAYG
      { nameEn: 'Contract income (B2B)', isPreTaxDefault: true }, // 按发票全额收款，不代扣税
      { nameEn: 'Interest', isPreTaxDefault: true }, // 银行不代扣税
      'Tax (ATO)', // 预缴税、BAS 记负数；退税记正数
      // Other（政府补贴、其他收入）由 withOther 生成
    ],
  },
];

function withOther(def: CategoryDef): SeedCategory {
  const named: SeedSubcategory[] = def.children.map((ch) =>
    typeof ch === 'string'
      ? { nameEn: ch, isPreTaxDefault: false, isOther: false }
      : { nameEn: ch.nameEn, isPreTaxDefault: ch.isPreTaxDefault, isOther: false },
  );
  return {
    nameEn: def.nameEn,
    kind: def.kind,
    defaultMember: def.defaultMember,
    children: [...named, { nameEn: OTHER_NAME, isPreTaxDefault: false, isOther: true }],
  };
}

export const SEED_CATEGORIES: SeedCategory[] = CATEGORY_DEFS.map(withOther);

// ---------- §4 系统分类 ----------

// 一级，没有二级，没有默认归属人，不可删除
export const SEED_SYSTEM_CATEGORIES: SeedSystemCategory[] = [
  { systemKey: 'internal_transfer', nameEn: 'Internal transfer' }, // 不计收支
  { systemKey: 'cash_withdrawal', nameEn: 'Cash withdrawal' }, // 计入支出
  { systemKey: 'bank_fee', nameEn: 'Bank fees' }, // 计入支出
  { systemKey: 'uncategorized', nameEn: 'Uncategorised' }, // 单独显示
];

// ---------- §5 预置规则 ----------

// 全部 contains / priority 0 / is_system。同时命中时关键词长的优先（R7）
export const SEED_RULE_DEFAULTS = {
  matchType: 'contains',
  priority: 0,
  isSystem: true,
} as const;

// 不要把真实的人名、客户名写进来（这个文件进 git）
function rulesFor(category: string, rows: [keyword: string, subcategory: string][]): SeedRule[] {
  return rows.map(([keyword, subcategory]) => ({ keyword, category, subcategory }));
}

export const SEED_RULES: SeedRule[] = [
  ...rulesFor('Groceries', [
    ['COLES', 'Supermarket'],
    ['WOOLWORTHS', 'Supermarket'],
    ['WW METRO', 'Supermarket'],
    ['ALDI', 'Supermarket'],
    ['IGA', 'Supermarket'],
    ['CROWN ASIAN', 'Supermarket'],
    ['MELB ASIAN MARKET', 'Supermarket'],
    ['ASIAN DELI', 'Supermarket'],
    ['DOWNTOWN GROCER', 'Supermarket'],
    ['EGGPORIUM', 'Supermarket'],
    ['MEATS', 'Butcher'],
    ['MEAT', 'Butcher'],
    ['FRESH FRUIT', 'Fruit'],
    ['APPLE CORNER', 'Fruit'],
    ['FRESH PEAR', 'Fruit'],
    ['VEGGIE', 'Vegetable'],
    ['VEGETABLES', 'Vegetable'],
    ['CONTINENTAL PRODUCE', 'Vegetable'], // ❓
    ['MARKET BOYS', 'Vegetable'], // ❓
    ['DOWNTOWN FRESH', 'Vegetable'], // ❓
    ['SEAFOOD', OTHER_NAME],
    ['BREAD', OTHER_NAME],
    ['BAKERS', OTHER_NAME],
  ]),
  ...rulesFor('Personal & medical', [
    ['KIS HAIR', 'Hair & beauty'],
    ['CHEMIST WAREHOUSE', 'Medicines & pharmacy'],
    ['PHARMACY', 'Medicines & pharmacy'],
    ['MEDICARE', OTHER_NAME], // 正数（报销），冲减 Personal & medical / Other（R7.1）
    ['MCARE BENEFITS', OTHER_NAME],
    ['I-MED', OTHER_NAME],
    ['UNIQLO', 'Clothing & shoes'],
    ['MYER', 'Clothing & shoes'], // ❓
    ['JB HI-FI', 'Computers & gadgets'],
    ['POP MART', 'Hobbies'],
    ['AMAZON', OTHER_NAME], // ❓
    ['TEMU', OTHER_NAME], // ❓
    ['APPLE.COM/BILL', OTHER_NAME], // ❓
    ['SPORTS DIRECT', 'Clothing & shoes'], // ❓
  ]),
  ...rulesFor('Entertainment & eat-out', [
    // Bubble tea 是奶茶店，Coffee & tea 是咖啡馆
    ['GONG CHA', 'Bubble tea'],
    ['TOP TEA', 'Bubble tea'],
    ['MOLLY TEA', 'Bubble tea'],
    ['SW WHITE', 'Bubble tea'], // 描述是 "272 SW WHITE ..."，前面数字是门店号，只取后半段
    ['COFFEE', 'Coffee & tea'],
    ['CAFE', 'Coffee & tea'], // ❓
    ['MESSINA', 'Take-away & snacks'],
    ['YOGURT', 'Take-away & snacks'],
    ['LUNE', 'Take-away & snacks'],
    ['KFC', 'Take-away & snacks'],
    ['MCDONALDS', 'Take-away & snacks'],
    ['DUMPLINGS', 'Take-away & snacks'],
    ['LANZHOU', 'Take-away & snacks'],
    ['NOODLES', 'Take-away & snacks'],
    ['FOOD FACTORY', 'Take-away & snacks'], // ❓
    ['SECRET KITCHEN', 'Restaurants'],
    ['POCHANA', 'Restaurants'],
    ['RIBS', 'Restaurants'],
    ['TAIWAN VILLAGE', 'Restaurants'],
    ['RESTAURANT', 'Restaurants'],
    ['MAGICCUISINE', 'Restaurants'],
    ['BRIGHT PALACE', 'Restaurants'],
    ['SON OF TUCCI', 'Restaurants'],
    ['EAT EAT', 'Restaurants'], // 转给朋友的聚餐 AA 款，备注里写了 "Eat Eat"
    ['TICKETEK', 'Movies & music'],
    ['FLORIS', 'Celebrations & gifts'],
  ]),
  ...rulesFor('Transport & auto', [
    ['MYKI', 'Public transport'],
    ['DEPARTMENT OF TRANSPOR', 'Public transport'], // ❓
    ['CHARGEFOX', 'Petrol / EV charging'],
    ['DIDIMOBILITY', OTHER_NAME],
    ['UBER', OTHER_NAME],
  ]),
  ...rulesFor('Home & utilities', [
    ['BPAY GWW', 'Water'],
    ['BPAY SEENE', 'Electricity'], // ❓
    ['BUNNINGS', 'Renovations & maintenance'],
    ['LIGHTNING BROADBAND', 'Internet'],
    ['AMAYSIM', 'Mobile'],
    ['LOAN REPAYMENT', 'Mortgage'], // ❓
    ['BPAY DEFT PAYMENTS', 'Body corporate fees'], // ❓
    ['BPAY CITY OF MELBOURNE', 'Council rates'],
  ]),
  ...rulesFor('Insurance & financial', [
    ['BUPA', 'Personal & life insurance'], // ❓ 健康险，分类里没有健康险，先放这里
    ['SUNCORP', OTHER_NAME], // ❓ 不确定是车险还是房屋险
  ]),
  ...rulesFor('Income', [
    // B2B 收入没有预置规则，第一次手动分到 Contract income (B2B) 时存成规则（R13）
    ['SALARY', 'Salary'], // CBA 工资描述以 "Salary" 开头
    ['CREDIT INTEREST', 'Interest'], // ❓
    ['TAX OFFICE', 'Tax (ATO)'], // ❓ ATO 的 BPAY 付款，拿到真实流水后确认描述格式
    ['CBA YELLO', OTHER_NAME], // CBA 房贷配套账户的每月返现
    ['REFUND FROM CBA', OTHER_NAME], // ❓
  ]),
];
