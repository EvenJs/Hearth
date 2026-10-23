// R3 清洗商家名（business-rules.md R3）
// 输入是 R2.3 脱敏后的描述，输出大写 merchant。ANZ 和 CBA 走同一套步骤，按文档顺序执行
// 纯函数，不 import 数据库和 Next.js

// R3 第 2 步：ANZ 交易类型前缀，只去开头，最多命中一个
const ANZ_PREFIXES: [pattern: RegExp, replacement: string][] = [
  [/^VISA DEBIT PURCHASE CARD \d{4}\b/, ''],
  [/^ANZ INTERNET BANKING BPAY\b/, 'BPAY'],
  [/^ANZ M-BANKING FUNDS TFER(?:\s+TRANSFER \d+)?/, 'TRANSFER'],
  [/^EFTPOS\b/, ''],
  [/^NON-ANZ ATM\b/, 'ATM'],
];

// R3 第 3 步：CBA 附加信息
const CBA_VALUE_DATE = / VALUE DATE: \d{2}\/\d{2}\/\d{4}/g;
const CBA_CARD = / AUS CARD XX\d{4}/g;
const CBA_BPAY = /^(.+?) COMMBANK APP BPAY .*$/;
// 顺序有关系：先去 " TO PAYID PHONE" 再去 " PAYID PHONE"，先去 " FROM COMMBANK APP" 再去 " COMMBANK APP"
const CBA_TRANSFER_NOISE = [
  ' TO PAYID PHONE',
  ' PAYID PHONE',
  ' FROM COMMBANK APP',
  ' COMMBANK APP',
];

// R3 第 4 步：开头的支付通道前缀
const CHANNEL_PREFIX = /^(?:ZLR\*|SQ \*|SMP\*|LS |\d+PIN\* )/;

// R3 第 5 步：BPAY 账单码
const BPAY_BILLER_CODE = /\{\d+\}/g;

// R3 第 8 步：结尾的地区词
const REGION_WORDS = new Set(['AU', 'AUS', 'VI', 'VIC', 'VICAU', 'NS', 'NSW']);

export function cleanMerchant(maskedDescription: string): string {
  // 1. 转大写
  let s = maskedDescription.toUpperCase().trim();

  // 2. ANZ 前缀
  for (const [pattern, replacement] of ANZ_PREFIXES) {
    if (pattern.test(s)) {
      s = s.replace(pattern, replacement);
      break;
    }
  }

  // 3. CBA 附加信息
  s = s.replace(CBA_VALUE_DATE, '').replace(CBA_CARD, '');
  s = s.replace(CBA_BPAY, 'BPAY $1');
  for (const noise of CBA_TRANSFER_NOISE) s = s.replaceAll(noise, '');

  // 4. 支付通道前缀（第 2 步去掉前缀后开头可能留空格，先 trim）
  s = s.trimStart().replace(CHANNEL_PREFIX, '');

  // 5. BPAY 账单码
  s = s.replace(BPAY_BILLER_CODE, '');

  // 6. 反斜杠换成空格
  s = s.replaceAll('\\', ' ');

  // 7. 合并空白，去首尾
  const words = s.split(/\s+/).filter(Boolean);

  // 8. 反复去掉结尾地区词，至少留一个词
  while (words.length > 1 && REGION_WORDS.has(words[words.length - 1])) words.pop();

  return words.join(' ');
}
