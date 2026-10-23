// 账户表单校验（F1、M1-5）。前端表单和 Server Action 共用同一个 schema
// 纯数据和校验，不 import 数据库；枚举值和 src/db/schema.ts 保持一致（有测试检查）
import { z } from 'zod';

export const BANKS = ['anz', 'anz_plus', 'cba', 'cash', 'other'] as const;
export const ACCOUNT_TYPES = ['everyday', 'savings', 'credit_card', 'joint', 'cash'] as const;

export type Bank = (typeof BANKS)[number];
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const BANK_LABELS: Record<Bank, string> = {
  anz: 'ANZ',
  anz_plus: 'ANZ Plus',
  cba: 'CBA',
  cash: '现金',
  other: '其他',
};

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  everyday: '日常',
  savings: '储蓄',
  credit_card: '信用卡',
  joint: 'Joint',
  cash: '现金',
};

// 尾号：空 = 不填；否则 4 到 6 位 ASCII 数字（schema.md financial_account.number_suffix）
const numberSuffix = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[0-9]{4,6}$/.test(v), '尾号是 4 到 6 位数字')
  .transform((v) => (v === '' ? null : v));

export const accountInputSchema = z
  .object({
    name: z.string().trim().min(1, '名称必填').max(50, '名称最多 50 个字'),
    bank: z.enum(BANKS, '请选择银行'),
    type: z.enum(ACCOUNT_TYPES, '请选择类型'),
    defaultMemberId: z.uuid('请选择默认归属人'),
    numberSuffix,
  })
  .superRefine((v, ctx) => {
    if (v.type === 'cash' && v.numberSuffix !== null) {
      ctx.addIssue({ code: 'custom', path: ['numberSuffix'], message: '现金账户不填尾号' });
    }
  });

export type AccountInput = z.input<typeof accountInputSchema>;
export type AccountValues = z.output<typeof accountInputSchema>;
