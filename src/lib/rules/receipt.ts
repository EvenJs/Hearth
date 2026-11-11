// 小票整理和校验（business-rules.md R20.1、R20.2）
// reader 的原始结果 → Zod 校验 → normalizeReceipt 整理 → checkReceipt 判断能不能保存
// 纯函数，不 import 数据库和 Next.js
import { z } from 'zod';
import { parseAuDate } from './date';
import { maskLongDigits } from './extract';
import { formatAud, parseBalanceToCents } from './money';

// ---------- R20.1 原始结果 ----------

// R20.1：所有 reader 共用。z.object 默认丢掉多的字段（人名、终端号、ABN、电话、完整卡号）
// 金额、日期都是原样字符串，由 normalizeReceipt 转换
// cardLast4 不是 3、4 位数字时当作 null，不让整张小票识别失败（2026-10-29 定）
// 3 位：NAB 的机器只打后 3 位（2026-11-08 改，R20.4 按"以它结尾"比）
export const rawReceiptSchema = z.object({
  merchant: z.string(),
  date: z.string().nullable(), // 读不出来时 reader 可以给 null，R20.2 让用户填
  total: z.string(),
  items: z.array(
    z.object({
      name: z.string(),
      amount: z.string(), // 单件折扣是负数
      category: z.string().nullable(), // `一级 / 二级`，null = 跟主分类（R20.3）
    }),
  ),
  discounts: z.array(
    z.object({
      label: z.string(),
      amount: z.string(), // 负数
    }),
  ),
  payment: z.object({
    method: z.enum(['card', 'cash', 'unknown']),
    // 只在内存里给 R20.4、R20.5 用，不入库
    cardLast4: z
      .string()
      .regex(/^\d{3,4}$/)
      .nullable()
      .catch(null),
  }),
});

export type RawReceipt = z.infer<typeof rawReceiptSchema>;
export type ReceiptPaymentMethod = RawReceipt['payment']['method'];

// ---------- R20.2 整理后的小票 ----------

// 能选的分类（R16.3 范围内 kind = expense 的二级）。label 是发给 reader 的 `一级 / 二级`
export type ReceiptCategoryOption = { id: string; label: string };

export type ReceiptItem = {
  name: string;
  amountCents: number | null; // null = 金额格式不对，见 errors.items
  categoryId: string | null; // null = 跟主分类（R20.3）
};

export type ReceiptDiscount = {
  label: string;
  amountCents: number | null; // null = 金额格式不对，见 errors.discounts
};

export type NormalizedReceipt = {
  merchant: string;
  date: string | null; // YYYY-MM-DD；null = 读不出来或不合法，见 errors.date
  totalCents: number | null; // null = 格式不对，见 errors.total
  items: ReceiptItem[];
  discounts: ReceiptDiscount[];
  // cardLast4 只在内存里用，M6.7-6 存 parsed_json 时去掉
  payment: { method: ReceiptPaymentMethod; cardLast4: string | null };
};

// 每个字段的错误单独返回，核对界面标在对应那行。items、discounts 按下标
export type ReceiptFieldErrors = {
  date?: string;
  total?: string;
  items: Record<number, string>;
  discounts: Record<number, string>;
};

export type NormalizeResult = { receipt: NormalizedReceipt; errors: ReceiptFieldErrors };

const MAX_NAME_LENGTH = 100;

// R20.2：去首尾空格 → 截 100 → R2.3 脱敏
function cleanName(input: string): string {
  return maskLongDigits(input.trim().slice(0, MAX_NAME_LENGTH).trim());
}

// R20.2：`$4.50`、`-$0.80`、`$-0.80`、`-0.80` → 整数分
// 去掉空格、前后各一个 `AUD`（不区分大小写）和一个 `$`，正负号在 `$` 前后都行，但只能有一个；
// 剩下的按 money.ts 的字符串口径
// 用 parseBalanceToCents 是因为它允许 0：0 不是格式问题，交给 checkReceipt 报
const RECEIPT_AMOUNT = /^([+-]?)\$?([+-]?)(\d.*)$/;

function parseReceiptAmount(input: string): number | null {
  const compact = input
    .replace(/\s+/g, '')
    .replace(/^AUD/i, '')
    .replace(/AUD$/i, '');
  const m = RECEIPT_AMOUNT.exec(compact);
  if (!m) return null;
  const [, signBefore, signAfter, number] = m;
  if (signBefore && signAfter) return null;
  try {
    return parseBalanceToCents(`${signBefore || signAfter}${number}`);
  } catch {
    return null;
  }
}

// R20.2 日期写法（2026-11-08 放宽，EFTPOS 机器格式各不一样）
// 末尾的时间：`11:30:53`、`12:03 PM`
const TRAILING_TIME = /\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?$/i;
const NUMERIC_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/; // D/M/YYYY、D/M/YY，日在前
const MONTH_FIRST_DATE = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/i; // NOV 08, 26、November 8, 2026
const DAY_FIRST_DATE = /^(\d{1,2})\s+([a-z]+)\s+(\d{2}|\d{4})$/i; // 8 Nov 2026、08 November 2026
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

// 英文缩写（前 3 个字母）或全称，不区分大小写 → 1 到 12；认不出是 null
function monthNumber(name: string): number | null {
  const lower = name.toLowerCase();
  const index = MONTHS.findIndex((m) => m === lower || m.slice(0, 3) === lower);
  return index === -1 ? null : index + 1;
}

// 认出的写法 → 补零的 DD/MM/YYYY，交给 parseAuDate 判断日期存不存在；认不出是 null
function toAuDate(input: string): string | null {
  const pad = (n: string | number) => String(n).padStart(2, '0');
  const year = (y: string) => (y.length === 2 ? `20${y}` : y); // 两位年份当 20YY

  let m = NUMERIC_DATE.exec(input);
  if (m) return `${pad(m[1])}/${pad(m[2])}/${year(m[3])}`;

  m = MONTH_FIRST_DATE.exec(input);
  if (m) {
    const month = monthNumber(m[1]);
    return month === null ? null : `${pad(m[2])}/${pad(month)}/${year(m[3])}`;
  }

  m = DAY_FIRST_DATE.exec(input);
  if (m) {
    const month = monthNumber(m[2]);
    return month === null ? null : `${pad(m[1])}/${pad(month)}/${year(m[3])}`;
  }

  m = ISO_DATE.exec(input);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  return null;
}

// R20.2：先去掉末尾的时间，再按上面几种写法转成 YYYY-MM-DD，不能晚于今天
// 不改 date.ts 的 parseAuDate：CSV 还要严格的 DD/MM/YYYY
type DateResult = { date: string; error?: undefined } | { date: null; error: string };

function parseReceiptDate(input: string | null, today: string): DateResult {
  const trimmed = input?.trim() ?? '';
  if (trimmed === '') return { date: null, error: '读不出日期，请填写' };

  const auDate = toAuDate(trimmed.replace(TRAILING_TIME, ''));
  let date: string;
  try {
    if (auDate === null) throw new Error('认不出');
    date = parseAuDate(auDate);
  } catch {
    return { date: null, error: `日期不对: "${trimmed}"` };
  }
  // YYYY-MM-DD 字符串可以直接比大小
  if (date > today) return { date: null, error: `日期不能晚于今天: "${trimmed}"` };
  return { date };
}

// R20.2 整理。today 用 todayInMelbourne()
// categories 是本家庭能选的分类，category 不在里面（LLM 编的、已归档）→ null，不报错
export function normalizeReceipt(
  raw: RawReceipt,
  categories: readonly ReceiptCategoryOption[],
  today: string,
): NormalizeResult {
  const categoryIdByLabel = new Map(categories.map((c) => [c.label.trim(), c.id]));
  const errors: ReceiptFieldErrors = { items: {}, discounts: {} };

  const dateResult = parseReceiptDate(raw.date, today);
  if (dateResult.error) errors.date = dateResult.error;

  const totalCents = parseReceiptAmount(raw.total);
  if (totalCents === null) errors.total = `总额格式不对: "${raw.total}"`;

  const items = raw.items.map((item, index): ReceiptItem => {
    const amountCents = parseReceiptAmount(item.amount);
    if (amountCents === null) errors.items[index] = `金额格式不对: "${item.amount}"`;
    return {
      name: cleanName(item.name),
      amountCents,
      categoryId:
        item.category === null ? null : (categoryIdByLabel.get(item.category.trim()) ?? null),
    };
  });

  const discounts = raw.discounts.map((d, index): ReceiptDiscount => {
    const amountCents = parseReceiptAmount(d.amount);
    if (amountCents === null) errors.discounts[index] = `金额格式不对: "${d.amount}"`;
    return { label: cleanName(d.label), amountCents };
  });

  return {
    receipt: {
      merchant: cleanName(raw.merchant),
      date: dateResult.date,
      totalCents,
      items,
      discounts,
      payment: { method: raw.payment.method, cardLast4: raw.payment.cardLast4 },
    },
    errors,
  };
}

// R20.2 只有付款单：items、discounts 都空，总额 > 0 → 补一件（名字 = 店名，空的用"付款单"，跟主分类）
// 只在 reader 的结果上调一次（scanReceipt）。saveReceipt 不调，用户删光商品照旧"至少一件商品"
export function addPaymentOnlyItem(receipt: NormalizedReceipt): NormalizedReceipt {
  const { items, discounts, totalCents } = receipt;
  if (items.length > 0 || discounts.length > 0 || totalCents === null || totalCents <= 0) {
    return receipt;
  }
  return {
    ...receipt,
    items: [{ name: receipt.merchant || '付款单', amountCents: totalCents, categoryId: null }],
  };
}

// ---------- R20.2 能不能保存 ----------

export type ReceiptCheckIssue =
  | { code: 'date_missing'; message: string }
  | { code: 'total_missing'; message: string }
  | { code: 'total_not_positive'; message: string }
  | { code: 'no_items'; message: string }
  | { code: 'item_amount_missing'; index: number; message: string }
  | { code: 'item_zero'; index: number; message: string }
  | { code: 'discount_amount_missing'; index: number; message: string }
  | { code: 'discount_not_negative'; index: number; message: string }
  // diffCents = 总额 − (商品合计 + 整单折扣)。正数 = 商品少了，负数 = 商品多了
  | { code: 'sum_mismatch'; diffCents: number; message: string };

export type ReceiptCheck = { ok: true } | { ok: false; issues: ReceiptCheckIssue[] };

// R20.2 的五条：总额 > 0；至少一件、每件 ≠ 0；整单折扣 < 0；商品合计 + 整单折扣 = 总额；日期有值
// 所有问题一起返回。有金额没解析出来时不比合计（没法算）
export function checkReceipt(receipt: NormalizedReceipt): ReceiptCheck {
  const issues: ReceiptCheckIssue[] = [];
  let amountsComplete = true;

  if (receipt.date === null) issues.push({ code: 'date_missing', message: '请填写小票日期' });

  if (receipt.totalCents === null) {
    amountsComplete = false;
    issues.push({ code: 'total_missing', message: '请填写总额' });
  } else if (receipt.totalCents <= 0) {
    issues.push({ code: 'total_not_positive', message: '总额必须大于 0（不支持退货小票）' });
  }

  if (receipt.items.length === 0) issues.push({ code: 'no_items', message: '至少要有一件商品' });

  receipt.items.forEach((item, index) => {
    if (item.amountCents === null) {
      amountsComplete = false;
      issues.push({ code: 'item_amount_missing', index, message: '请填写金额' });
    } else if (item.amountCents === 0) {
      issues.push({ code: 'item_zero', index, message: '金额不能为 0' });
    }
  });

  receipt.discounts.forEach((d, index) => {
    if (d.amountCents === null) {
      amountsComplete = false;
      issues.push({ code: 'discount_amount_missing', index, message: '请填写金额' });
    } else if (d.amountCents >= 0) {
      issues.push({ code: 'discount_not_negative', index, message: '整单折扣必须是负数' });
    }
  });

  if (amountsComplete && receipt.totalCents !== null) {
    const sum =
      receipt.items.reduce((s, i) => s + (i.amountCents ?? 0), 0) +
      receipt.discounts.reduce((s, d) => s + (d.amountCents ?? 0), 0);
    const diffCents = receipt.totalCents - sum;
    if (diffCents !== 0) {
      issues.push({
        code: 'sum_mismatch',
        diffCents,
        message: `差 ${formatAud(Math.abs(diffCents))}`,
      });
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
