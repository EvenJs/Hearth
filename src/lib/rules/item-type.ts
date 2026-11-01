// R21：小票商品类型匹配
// 纯函数，不 import 数据库和 Next.js

import { normalizeKeyword } from './keyword';

// R21.1：类型列表，下拉、统计都按这个顺序。别的地方从这里 import
export const ITEM_TYPES = [
  { key: 'fruit', label: '水果' },
  { key: 'vegetable', label: '蔬菜' },
  { key: 'meat', label: '肉' },
  { key: 'seafood', label: '海鲜' },
  { key: 'dairy_egg', label: '乳制品和蛋' },
  { key: 'pantry', label: '主食干货' },
  { key: 'snack', label: '零食' },
  { key: 'drink', label: '饮料' },
  { key: 'household', label: '日用' },
  { key: 'other', label: '其他' },
] as const;

export type ItemType = (typeof ITEM_TYPES)[number]['key'];

// R21.3、R21.4：learned / preset / default 来自 matchItemType，follow 只有负数商品
export type ItemTypeSource = 'learned' | 'preset' | 'default' | 'follow';
export type ItemTypeMatch = { type: ItemType; source: ItemTypeSource };

// R21.5：学习表，name_key（normalizeItemName 以后）→ 类型
export type LearnedItemTypes = ReadonlyMap<string, ItemType>;

// R21.2：预置关键词，存大写，对规范化后的商品名做包含匹配。一个词只在一个类型里
export const ITEM_TYPE_KEYWORDS: Record<ItemType, readonly string[]> = {
  fruit: [
    'BANANA',
    'APPLE',
    'KIWI',
    'ORANGE',
    'MANDARIN',
    'GRAPE',
    'STRAWBERR',
    'BLUEBERR',
    'RASPBERR',
    'MANGO',
    'PEAR',
    'PEACH',
    'PLUM',
    'CHERR',
    'LEMON',
    'LIME',
    'AVOCADO',
    'WATERMELON',
    'MELON',
    'PINEAPPLE',
  ],
  vegetable: [
    'LETTUCE',
    'POTATO',
    'TOMATO',
    'ONION',
    'CARROT',
    'BROCCOLI',
    'CABBAGE',
    'CUCUMBER',
    'CAPSICUM',
    'SPINACH',
    'MUSHROOM',
    'ZUCCHINI',
    'PUMPKIN',
    'BUTTERNUT',
    'CELERY',
    'GARLIC',
    'GINGER',
    'BOK CHOY',
    'EGGPLANT',
    'ASPARAGUS',
  ],
  meat: [
    'BEEF',
    'PORK',
    'LAMB',
    'CHICKEN',
    'MINCE',
    'STEAK',
    'SAUSAGE',
    'BACON',
    'SALAMI',
    'THIGH',
    'DRUMSTICK',
  ],
  seafood: ['SALMON', 'PRAWN', 'SHRIMP', 'TUNA', 'FISH', 'BARRAMUNDI', 'SQUID', 'MUSSEL', 'OYSTER'],
  dairy_egg: ['MILK', 'CHEESE', 'YOGHURT', 'YOGURT', 'BUTTER', 'CREAM', 'EGG'],
  pantry: [
    'RICE',
    'PASTA',
    'SPAGHETTI',
    'NOODLE',
    'FLOUR',
    'BREAD',
    'SUGAR',
    'SALT',
    'OLIVE OIL',
    'CANOLA',
    'VINEGAR',
    'SAUCE',
    'STOCK',
    'CEREAL',
    'OATS',
    'DUMPLING',
    'TOFU',
    'TORTILLA',
    'HONEY',
    'PEANUT BUTTER',
    'COCONUT MILK',
    'BAKED BEANS',
    'OYSTER SAUCE',
    'FISH SAUCE',
    'TOMATO SAUCE',
  ],
  snack: [
    'CHIPS',
    'POTATO CHIP',
    'BISCUIT',
    'COOKIE',
    'CHOC',
    'CHOCOLATE',
    'CANDY',
    'LOLLIES',
    'ICE CREAM',
    'CRACKER',
    'POPCORN',
    'MUESLI BAR',
  ],
  drink: [
    'JUICE',
    'WATER',
    'SODA',
    'COLA',
    'SOFT DRINK',
    'BEER',
    'GINGER BEER',
    'WINE',
    'COFFEE',
    'KOMBUCHA',
    'LEMONADE',
  ],
  household: [
    'TISSUE',
    'TOILET',
    'PAPER TOWEL',
    'DISHWASH',
    'DETERGENT',
    'LAUNDRY',
    'BLEACH',
    'SPONGE',
    'FOIL',
    'CLING WRAP',
    'GARBAGE BAG',
    'SHAMPOO',
    'CONDITIONER',
    'TOOTHPASTE',
    'TOOTHBRUSH',
    'SOAP',
    'BODY WASH',
    'DEODORANT',
    'NAPPIES',
    'BATTERY',
    'PARACETAMOL',
    'IBUPROFEN',
  ],
  other: [],
};

const PRESET = Object.entries(ITEM_TYPE_KEYWORDS).flatMap(([type, words]) =>
  words.map((keyword) => ({ keyword, type: type as ItemType })),
);

// R21.3：同 normalizeKeyword，去首尾空格、多个空格合成一个、转大写
export function normalizeItemName(name: string): string {
  return normalizeKeyword(name);
}

// R21.3：学到的（完全相同）> 预置关键词（包含；长的优先，一样长取位置靠后的）> other
export function matchItemType(name: string, learned: LearnedItemTypes): ItemTypeMatch {
  const key = normalizeItemName(name);

  const learnedType = learned.get(key);
  if (learnedType) return { type: learnedType, source: 'learned' };

  let best: { type: ItemType; length: number; position: number } | null = null;
  for (const { keyword, type } of PRESET) {
    const position = key.lastIndexOf(keyword);
    if (position < 0) continue;
    const length = keyword.length;
    if (!best || length > best.length || (length === best.length && position > best.position)) {
      best = { type, length, position };
    }
  }
  if (best) return { type: best.type, source: 'preset' };

  return { type: 'other', source: 'default' };
}

// R21.4：一整张小票。负数商品跟前面最近的正数商品，第一行就是负数 → other
// 金额还没填对（null）的行按名字认，同正数商品
export function assignItemTypes(
  items: readonly { name: string; amountCents: number | null }[],
  learned: LearnedItemTypes,
): ItemTypeMatch[] {
  let previous: ItemType | null = null;
  return items.map((item) => {
    if (item.amountCents !== null && item.amountCents < 0) {
      return previous ? { type: previous, source: 'follow' } : { type: 'other', source: 'default' };
    }
    const match = matchItemType(item.name, learned);
    previous = match.type;
    return match;
  });
}
