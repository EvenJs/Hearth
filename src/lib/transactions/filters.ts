// F8 流水查询的筛选条件：URL 参数 ↔ 筛选条件（M5 看板带筛选跳过来也用这里）
// 约定（M4-2）：金额范围按交易金额的绝对值；账户、归属人、分类单选；没有时间段 = 全部时间
// URL 是用户能手改的，不合法的参数直接丢掉，不报错
// 纯函数，不 import 数据库和 Next.js
import { z } from 'zod';
import { parseBalanceToCents } from '@/lib/rules/money';
import {
  PRESET_PERIODS,
  periodRange,
  type DateRange,
  type PresetPeriod,
} from '@/lib/rules/periods';
import { TRANSACTION_TYPES, type TransactionType } from '@/lib/rules/split-edit';

export const TRANSACTION_STATUSES = ['pending', 'confirmed'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const QUICK_FILTERS = ['uncategorized', 'suggested'] as const;
export type QuickFilter = (typeof QUICK_FILTERS)[number];

export type TransactionFilters = {
  period?: PresetPeriod | DateRange; // R10.1；不传 = 全部时间
  accountId?: string;
  memberId?: string; // 拆分的归属人
  categoryId?: string; // 拆分的分类；一级时包含它所有的二级
  type?: TransactionType; // R16.5，按拆分的分类
  status?: TransactionStatus; // transaction.status
  isPreTax?: boolean; // 拆分的 is_pre_tax
  merchant?: string; // 商家关键词，不区分大小写
  minCents?: number; // 交易金额绝对值 ≥，含
  maxCents?: number; // 交易金额绝对值 ≤，含
  quick?: QuickFilter; // 未分类（拆分）、建议转账（transfer_status = suggested）
};

// R16.5：这些条件看拆分。有任何一个时，列表里只要有一个拆分命中就列出，合计只加命中的拆分
export function hasSplitFilter(f: TransactionFilters): boolean {
  return (
    f.categoryId !== undefined ||
    f.memberId !== undefined ||
    f.type !== undefined ||
    f.isPreTax !== undefined ||
    f.quick === 'uncategorized'
  );
}

// ---------- URL 参数 → 筛选条件 ----------

// Next.js 页面的 searchParams，或者 URLSearchParams
export type SearchParamsInput = URLSearchParams | Record<string, string | string[] | undefined>;

function getParam(params: SearchParamsInput, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

// 金额输入是元，正数，最多 2 位小数；允许 $ 和千分位逗号
const AMOUNT = /^\d+(\.\d{1,2})?$/;

const uuid = z.uuid();
const preset = z.enum(PRESET_PERIODS);
const type = z.enum(TRANSACTION_TYPES);
const status = z.enum(TRANSACTION_STATUSES);
const quick = z.enum(QUICK_FILTERS);
const pretax = z.enum(['1', '0']).transform((v) => v === '1');
const merchant = z.string().trim().min(1).max(100);
const amount = z
  .string()
  .transform((v) => v.replace(/[\s$,]/g, ''))
  .refine((v) => AMOUNT.test(v))
  .transform((v) => parseBalanceToCents(v));

// 不合法 → undefined
function read<T>(schema: z.ZodType<T, string>, value: string | undefined): T | undefined {
  if (value === undefined) return undefined;
  const r = schema.safeParse(value);
  return r.success ? r.data : undefined;
}

// R10.1 自定义时间段：两个都是合法的 YYYY-MM-DD，且 from ≤ to（periodRange 负责检查）
function readCustomRange(from: string | undefined, to: string | undefined): DateRange | undefined {
  if (!from || !to) return undefined;
  try {
    const { start, end } = periodRange({ start: from, end: to }, from);
    return { start, end };
  } catch {
    return undefined;
  }
}

export function filtersFromSearchParams(params: SearchParamsInput): TransactionFilters {
  const get = (key: string) => getParam(params, key);
  const f: TransactionFilters = {
    period: read(preset, get('period')) ?? readCustomRange(get('from'), get('to')),
    accountId: read(uuid, get('account')),
    memberId: read(uuid, get('member')),
    categoryId: read(uuid, get('category')),
    type: read(type, get('type')),
    status: read(status, get('status')),
    isPreTax: read(pretax, get('pretax')),
    merchant: read(merchant, get('q')),
    minCents: read(amount, get('min')),
    maxCents: read(amount, get('max')),
    quick: read(quick, get('quick')),
  };
  // 去掉 undefined，方便比较和转回 URL
  return Object.fromEntries(
    Object.entries(f).filter(([, v]) => v !== undefined),
  ) as TransactionFilters;
}

// 页码从 1 开始，不合法 → 1
export function pageFromSearchParams(params: SearchParamsInput): number {
  const v = getParam(params, 'page');
  if (!v || !/^\d+$/.test(v)) return 1;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

// ---------- 筛选条件 → URL 参数 ----------

// 1234 → "12.34"，整数运算，不经过浮点数
function centsToDollars(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// 顺序固定，同样的筛选条件总是得到同样的 URL
export function filtersToSearchParams(f: TransactionFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (typeof f.period === 'string') p.set('period', f.period);
  if (typeof f.period === 'object') {
    p.set('from', f.period.start);
    p.set('to', f.period.end);
  }
  if (f.accountId) p.set('account', f.accountId);
  if (f.memberId) p.set('member', f.memberId);
  if (f.categoryId) p.set('category', f.categoryId);
  if (f.type) p.set('type', f.type);
  if (f.status) p.set('status', f.status);
  if (f.isPreTax !== undefined) p.set('pretax', f.isPreTax ? '1' : '0');
  if (f.merchant) p.set('q', f.merchant);
  if (f.minCents !== undefined) p.set('min', centsToDollars(f.minCents));
  if (f.maxCents !== undefined) p.set('max', centsToDollars(f.maxCents));
  if (f.quick) p.set('quick', f.quick);
  return p;
}
