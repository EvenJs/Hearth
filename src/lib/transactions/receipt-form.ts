// 小票核对界面的表单状态（M6.7-7，business-rules.md R20.2、R20.3）
// 表单里金额是用户能改的字符串；保存时转回 reader 原始结果的格式（R20.1），服务器重新整理、校验
// 合计提示用同一套纯函数（normalizeReceipt、checkReceipt）在浏览器里实时算
import {
  checkReceipt,
  normalizeReceipt,
  type NormalizedReceipt,
  type RawReceipt,
  type ReceiptCategoryOption,
  type ReceiptCheck,
  type ReceiptFieldErrors,
  type ReceiptPaymentMethod,
} from '@/lib/rules/receipt';

export type ReceiptItemValue = {
  key: string; // React 列表的 key，不保存
  name: string;
  amount: string; // 单件折扣是负数
  categoryId: string | null; // null = 跟主分类（负数跟上一件），R20.3 第 1 步
};

export type ReceiptDiscountValue = { key: string; label: string; amount: string };

export type ReceiptFormValues = {
  merchant: string;
  date: string; // YYYY-MM-DD（<input type="date">），空字符串 = 还没填
  total: string;
  payment: ReceiptPaymentMethod;
  cardLast4: string | null; // reader 读到的，只在内存里（R20.4、R20.5），保存时服务器去掉
  items: ReceiptItemValue[];
  discounts: ReceiptDiscountValue[];
};

// 整数分 → 表单里的字符串，带符号。-80 → "-0.80"（整数运算，不经过浮点数）
export function centsToReceiptInput(cents: number | null): string {
  if (cents === null) return '';
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// scanReceipt 返回的草稿 → 表单
export function draftToForm(r: NormalizedReceipt, newKey: () => string): ReceiptFormValues {
  return {
    merchant: r.merchant,
    date: r.date ?? '',
    total: centsToReceiptInput(r.totalCents),
    payment: r.payment.method,
    cardLast4: r.payment.cardLast4,
    items: r.items.map((i) => ({
      key: newKey(),
      name: i.name,
      amount: centsToReceiptInput(i.amountCents),
      categoryId: i.categoryId,
    })),
    discounts: r.discounts.map((d) => ({
      key: newKey(),
      label: d.label,
      amount: centsToReceiptInput(d.amountCents),
    })),
  };
}

// YYYY-MM-DD → DD/MM/YYYY（R20.2 认的格式）
function toAuDate(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

// 表单 → reader 原始结果的格式（R20.1），交给 normalizeReceipt。分类 id 换成 `一级 / 二级`
export function formToRaw(
  v: ReceiptFormValues,
  categories: readonly ReceiptCategoryOption[],
): RawReceipt {
  const labelOf = new Map(categories.map((c) => [c.id, c.label]));
  return {
    merchant: v.merchant,
    date: toAuDate(v.date),
    total: v.total,
    items: v.items.map((i) => ({
      name: i.name,
      amount: i.amount,
      category: i.categoryId === null ? null : (labelOf.get(i.categoryId) ?? null),
    })),
    discounts: v.discounts.map((d) => ({ label: d.label, amount: d.amount })),
    payment: { method: v.payment, cardLast4: v.cardLast4 },
  };
}

export type LiveCheck = {
  receipt: NormalizedReceipt;
  errors: ReceiptFieldErrors; // 标在对应那行
  check: ReceiptCheck; // R20.2 能不能保存
  // 商品合计、整单折扣合计（负数）。有金额填错时为 null
  itemsCents: number | null;
  discountsCents: number | null;
  // 总额 − (商品合计 + 整单折扣)；算不出来时为 null。正数 = 商品少了
  diffCents: number | null;
};

const sumOrNull = (amounts: readonly (number | null)[]) =>
  amounts.some((a) => a === null) ? null : amounts.reduce<number>((s, a) => s + (a as number), 0);

// R20.2：实时算"合计对上了"或"差 $X"
export function liveCheck(
  v: ReceiptFormValues,
  categories: readonly ReceiptCategoryOption[],
  today: string,
): LiveCheck {
  const { receipt, errors } = normalizeReceipt(formToRaw(v, categories), categories, today);
  const itemsCents = sumOrNull(receipt.items.map((i) => i.amountCents));
  const discountsCents = sumOrNull(receipt.discounts.map((d) => d.amountCents));
  const diffCents =
    itemsCents === null || discountsCents === null || receipt.totalCents === null
      ? null
      : receipt.totalCents - itemsCents - discountsCents;
  return { receipt, errors, check: checkReceipt(receipt), itemsCents, discountsCents, diffCents };
}

// R20.3 第 1 步：每一行分类怎么来的，给下拉框显示"跟主分类" / "跟上一件"
// set：选了分类；main：跟主分类；previous：负数（单件折扣）跟上一件，第一行就是负数时跟主分类
export type ItemCategoryHint = 'set' | 'main' | 'previous';

export function itemCategoryHints(items: readonly ReceiptItemValue[]): ItemCategoryHint[] {
  return items.map((item, index) => {
    if (item.categoryId !== null) return 'set';
    const compact = item.amount.replace(/\s+/g, '');
    const negative = compact.startsWith('-') || compact.startsWith('$-');
    return negative && index > 0 ? 'previous' : 'main';
  });
}
