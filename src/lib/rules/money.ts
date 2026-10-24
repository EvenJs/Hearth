// 金额工具（business-rules.md R1.0-4）
// 金额一律是整数分。字符串转分全程用字符串和整数，不经过浮点数
// 纯函数，不 import 数据库和 Next.js

// Postgres integer 上限，amount_cents 和 balance_cents 都是 integer
const MAX_CENTS = 2_147_483_647;

// 可选正负号 + 整数部分 + 可选 1 到 2 位小数。不支持千分位逗号（银行导出不会有）
const AMOUNT = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/;

// 字符串（元）→ 整数分，不检查是否为 0
function parseCents(input: string, label: string): number {
  const m = AMOUNT.exec(input.trim());
  if (!m) throw new Error(`${label}格式不对: "${input}"`);

  const [, sign, whole, fraction = ''] = m;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  if (cents > MAX_CENTS) throw new Error(`${label}太大: "${input}"`);
  if (cents === 0) return 0; // 不返回 -0
  return sign === '-' ? -cents : cents;
}

// R1.0-4：输入单位是元，返回整数分。"-58.40" → -5840，"+500.00" → 50000，"5" → 500
// 格式不对或金额为 0 时抛错
export function parseAmountToCents(input: string): number {
  const cents = parseCents(input, '金额');
  if (cents === 0) throw new Error(`金额不能为 0: "${input}"`);
  return cents;
}

// R1B：CBA 的余额，规则和金额一样，但可以是 0。"+11561.59" → 1156159
export function parseBalanceToCents(input: string): number {
  return parseCents(input, '余额');
}

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });

// 显示用：-5840 → "-$58.40"
export function formatAud(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`金额必须是整数分: ${cents}`);
  return AUD.format(cents / 100);
}
