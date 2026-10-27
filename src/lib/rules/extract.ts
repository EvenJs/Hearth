// R2 提取和脱敏（business-rules.md R2）
// 顺序：先提取（R2.1、R2.2），再脱敏（R2.3）。纯函数，不 import 数据库和 Next.js

// R2.1：ANZ "CARD 1111"、CBA "Card xx1234"
const CARD_LAST4 = /\bCARD (?:XX)?(\d{4})\b/i;

// R2.2：只在描述含 FUNDS TFER 或 TRANSFER 时提取
const TRANSFER_KEYWORD = /FUNDS TFER|TRANSFER/i;
// 完整账号（ANZ），8 位以上，流水号 681801 只有 6 位不会命中
// 前面可能带 6 位 BSB 和 -（转去 ANZ Plus：TO 012345-400000004），BSB 不算账号
const TRANSFER_FULL_ACCOUNT = /\b(?:FROM|TO)\s+(?:\d{6}-)?(\d{8,})\b/i;
// 银行已经打码的尾号（CBA）
const TRANSFER_MASKED_SUFFIX = /\b(?:FROM|TO)\s+XX(\d{4})\b/i;

// R12.1：数据库里存的是 R2.3 脱敏后的描述，ANZ 完整账号已经变成 ****1234
// R2.2 带 BSB 的变成 012345-****1234，一样取 1234
const TRANSFER_STORED_SUFFIX = /\b(?:FROM|TO)\s+(?:\d{6}-)?\*{4}(\d{4})\b/i;

// R2.3：连续 8 位及以上数字
const LONG_DIGITS = /\d{8,}/g;

export type ExtractResult = {
  description: string; // R2.3 脱敏后的描述，可以入库
  cardLast4: string | null; // R2.1
  transferAccount: string | null; // R2.2，只在内存里给 R6 用，不入库
};

// R2.1 卡号后四位，没有 → null
export function extractCardLast4(description: string): string | null {
  return CARD_LAST4.exec(description)?.[1] ?? null;
}

// R2.2 转账对方账号：ANZ 返回完整账号，CBA 返回 4 位尾号，PayID 转账（只有人名）→ null
export function extractTransferAccount(description: string): string | null {
  if (!TRANSFER_KEYWORD.test(description)) return null;
  return (
    TRANSFER_FULL_ACCOUNT.exec(description)?.[1] ??
    TRANSFER_MASKED_SUFFIX.exec(description)?.[1] ??
    null
  );
}

// R12.1 撤销时、R6.4 保存账户时重跑 R6.1：从脱敏后的描述里取 4 位尾号
// ****1234、012345-****1234 → 1234；CBA 的 xx5678 脱敏时不受影响，照常取 5678。同 R2.2，只在含 FUNDS TFER 或 TRANSFER 时取
// 返回的 4 位数字按 CBA 的方式匹配（家庭账户尾号以它结尾），直接交给 detectTransfer
export function extractMaskedTransferSuffix(maskedDescription: string): string | null {
  if (!TRANSFER_KEYWORD.test(maskedDescription)) return null;
  return (
    TRANSFER_STORED_SUFFIX.exec(maskedDescription)?.[1] ??
    TRANSFER_MASKED_SUFFIX.exec(maskedDescription)?.[1] ??
    null
  );
}

// R2.3 把 8 位以上连续数字换成 **** + 后 4 位
export function maskLongDigits(description: string): string {
  return description.replace(LONG_DIGITS, (digits) => `****${digits.slice(-4)}`);
}

// R2：先在原文上提取，再脱敏
export function extractAndMask(description: string): ExtractResult {
  return {
    description: maskLongDigits(description),
    cardLast4: extractCardLast4(description),
    transferAccount: extractTransferAccount(description),
  };
}
