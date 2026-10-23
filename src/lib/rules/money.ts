// 金额工具（business-rules.md R1.0-4）
// 金额一律是整数分。字符串转分全程用字符串和整数，不经过浮点数
// 纯函数，不 import 数据库和 Next.js

// Postgres integer 上限，amount_cents 和 balance_cents 都是 integer
const MAX_CENTS = 2_147_483_647;

// 可选正负号 + 整数部分 + 可选 1 到 2 位小数。不支持千分位逗号（银行导出不会有）
const AMOUNT = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/;

// R1.0-4："-58.40" → -5840，"+500.00" → 50000，"5" → 500。格式不对或金额为 0 时抛错
export function parseAmountToCents(input: string): number {
  const m = AMOUNT.exec(input.trim());
  if (!m) throw new Error(`金额格式不对: "${input}"`);

  const [, sign, whole, fraction = ''] = m;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  if (cents === 0) throw new Error(`金额不能为 0: "${input}"`);
  if (cents > MAX_CENTS) throw new Error(`金额太大: "${input}"`);

  return sign === '-' ? -cents : cents;
}

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });

// 显示用：-5840 → "-$58.40"
export function formatAud(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`金额必须是整数分: ${cents}`);
  return AUD.format(cents / 100);
}
