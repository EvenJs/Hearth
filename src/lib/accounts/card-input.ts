// 卡号映射校验（F1、M1-6）：卡号后四位 → 归属人，用于 R5 第 3 优先级
// 前端表单和 Server Action 共用；同一账户下不能重复由数据库唯一约束 (account_id, last4) 保证
import { z } from 'zod';

export const cardInputSchema = z.object({
  last4: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, '后四位是 4 位数字'),
  memberId: z.uuid('请选择归属人'),
  label: z
    .string()
    .trim()
    .max(50, '备注最多 50 个字')
    .transform((v) => (v === '' ? null : v)),
});

export type CardInput = z.input<typeof cardInputSchema>;
export type CardValues = z.output<typeof cardInputSchema>;
