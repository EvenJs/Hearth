// F8 交易详情的拆分表单（M4-10）：金额输入、主拆分剩余的实时提示、归属人来源说明
// 只用来在界面上提示，真正的校验在 src/lib/rules/split.ts（R15.2、R15.3），由服务端做
// 纯函数，不 import 数据库和 Next.js
import { parseAmountToCents } from '@/lib/rules/money';
import type { MemberSource } from '@/lib/rules/types';

export type ParsedAmount = { ok: true; cents: number } | { ok: false; message: string };

// R15.2：用户填正数（元），返回整数分。不接受正负号，0 不通过
export function parseSplitAmountInput(input: string): ParsedAmount {
  const s = input.trim();
  if (s === '') return { ok: false, message: '请填金额' };
  if (/^[+-]/.test(s)) return { ok: false, message: '填正数，符号会按交易自动处理' };
  try {
    return { ok: true, cents: parseAmountToCents(s) };
  } catch {
    return {
      ok: false,
      message: /^0*(\.0*)?$/.test(s) ? '金额必须大于 0' : '金额格式不对，比如 15.00',
    };
  }
}

// 编辑拆分时填好原来的金额：按绝对值，两位小数。-800 → "8.00"（整数运算，不经过浮点数）
export function centsToAmountInput(cents: number): string {
  const abs = Math.abs(cents);
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export type AmountPreview = {
  ok: boolean; // 金额 < 上限
  remainingCents: number; // 保存后主拆分的金额（和交易同符号）
  limitCents: number; // 金额必须小于它（正数）
};

// R15.2 拆出一部分：金额 < 主拆分当前金额的绝对值
// R15.3 改非主拆分：currentCents 是这一笔原来的金额，上限 = |主拆分| + |原来的金额|
// inputCents 是用户填的正数，还没填（或填错）时传 null
export function splitAmountPreview(input: {
  primaryCents: number;
  currentCents?: number;
  inputCents: number | null;
}): AmountPreview {
  const { primaryCents, currentCents = 0, inputCents } = input;
  const sign = primaryCents < 0 ? -1 : 1;
  const limitCents = Math.abs(primaryCents) + Math.abs(currentCents);
  if (inputCents === null) return { ok: false, remainingCents: primaryCents, limitCents };
  return {
    ok: inputCents > 0 && inputCents < limitCents,
    remainingCents: primaryCents + currentCents - sign * inputCents,
    limitCents,
  };
}

// R5：归属人是按哪一条定的
export function memberSourceLabel(source: MemberSource, cardLast4: string | null): string {
  switch (source) {
    case 'manual':
      return '手动指定';
    case 'category':
      return '按分类';
    case 'card':
      return cardLast4 ? `卡号 ${cardLast4}` : '按卡号';
    case 'account':
      return '账户默认';
  }
}
