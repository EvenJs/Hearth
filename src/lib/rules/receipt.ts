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
// cardLast4 不是 4 位数字时当作 null，不让整张小票识别失败（2026-10-29 定）
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
      .regex(/^\d{4}$/)
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
// 去掉空格和一个 `$`，正负号在 `$` 前后都行，但只能有一个；剩下的按 money.ts 的字符串口径
// 用 parseBalanceToCents 是因为它允许 0：0 不是格式问题，交给 checkReceipt 报
const RECEIPT_AMOUNT = /^([+-]?)\$?([+-]?)(\d.*)$/;

function parseReceiptAmount(input: string): number | null {
  const m = RECEIPT_AMOUNT.exec(input.replace(/\s+/g, ''));
  if (!m) return null;
  const [, signBefore, signAfter, number] = m;
  if (signBefore && signAfter) return null;
  try {
    return parseBalanceToCents(`${signBefore || signAfter}${number}`);
  } catch {
    return null;
  }
}

const SHORT_YEAR_DATE = /^(\d{2})\/(\d{2})\/(\d{2})$/;

// R20.2：DD/MM/YYYY、DD/MM/YY（两位年份当 20YY）→ YYYY-MM-DD，不能晚于今天
type DateResult = { date: string; error?: undefined } | { date: null; error: string };

function parseReceiptDate(input: string | null, today: string): DateResult {
  const trimmed = input?.trim() ?? '';
  if (trimmed === '') return { date: null, error: '读不出日期，请填写' };

  const short = SHORT_YEAR_DATE.exec(trimmed);
  const full = short ? `${short[1]}/${short[2]}/20${short[3]}` : trimmed;

  let date: string;
  try {
    date = parseAuDate(full);
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
