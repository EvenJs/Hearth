// 账户表单校验（F1、M1-5）。前端表单和 Server Action 共用同一个 schema
// 纯数据和校验，不 import 数据库；枚举值和 src/db/schema.ts 保持一致（有测试检查）
import { z } from 'zod';
import { ACCOUNT_PURPOSES } from '@/lib/rules/balance';

export const BANKS = ['anz', 'anz_plus', 'cba', 'boq', 'westpac', 'ing', 'cash', 'other'] as const;
export const ACCOUNT_TYPES = ['everyday', 'savings', 'credit_card', 'joint', 'cash'] as const;

export type Bank = (typeof BANKS)[number];
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const BANK_LABELS: Record<Bank, string> = {
  anz: 'ANZ',
  anz_plus: 'ANZ Plus',
  cba: 'CBA',
  boq: 'BOQ',
  westpac: 'Westpac',
  ing: 'ING',
  cash: '现金',
  other: '其他',
};

// M13-12 改成账户卡片第二行的叫法，设置页的下拉和表格同一套
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  everyday: '日常卡',
  savings: '储蓄账户',
  credit_card: '信用卡',
  joint: '联名',
  cash: '现金',
};

// 尾号：空 = 不填；否则 ASCII 数字，位数按银行在 superRefine 里查（schema.md financial_account.number_suffix）
const numberSuffix = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v));

// R6.1 对账单上的账户名。空 = 不填
const statementName = z
  .string()
  .trim()
  .max(50, '账户名最多 50 个字')
  .transform((v) => (v === '' ? null : v))
  .nullable();

export const accountInputSchema = z
  .object({
    name: z.string().trim().min(1, '名称必填').max(50, '名称最多 50 个字'),
    bank: z.enum(BANKS, '请选择银行'),
    type: z.enum(ACCOUNT_TYPES, '请选择类型'),
    defaultMemberId: z.uuid('请选择默认归属人'),
    numberSuffix,
    // R6.1。不传 = 新建不填、编辑不改；null = 不填
    statementName: statementName.optional(),
    // R23.4。不传 = 新建用默认 everyday、编辑不改
    purpose: z.enum(ACCOUNT_PURPOSES, '请选择用途').optional(),
    // R23.4。不传 = 新建不关联、编辑不改；null = 不关联
    linkedAccountId: z.uuid('找不到这个账户').nullable().optional(),
    // R23.1 开户余额（分），只有新建用，默认 0。编辑时忽略
    openingBalanceCents: z.number().int('金额不对').min(-2147483648).max(2147483647).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.numberSuffix === null) return;
    if (v.type === 'cash') {
      ctx.addIssue({ code: 'custom', path: ['numberSuffix'], message: '现金账户不填尾号' });
    } else if (v.bank === 'westpac') {
      // R1G：Westpac 账号只有 6 位，填 3 位，撞了加 1 位，最多 5 位
      if (!/^[0-9]{3,5}$/.test(v.numberSuffix)) {
        ctx.addIssue({
          code: 'custom',
          path: ['numberSuffix'],
          message: 'Westpac 尾号是 3 到 5 位数字（账号只有 6 位，不能填满）',
        });
      }
    } else if (!/^[0-9]{4,6}$/.test(v.numberSuffix)) {
      ctx.addIssue({ code: 'custom', path: ['numberSuffix'], message: '尾号是 4 到 6 位数字' });
    }
  });

export type AccountInput = z.input<typeof accountInputSchema>;
export type AccountValues = z.output<typeof accountInputSchema>;
