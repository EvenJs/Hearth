// 一个文件的完整处理管道（business-rules.md R12 第 2 步，和第 5 步里"新交易"的部分）
// 解析 → R2 提取脱敏 → R3 清洗 → R4 key → R6.1 转账 → R7 分类 → R5 归属人
// 分两步（M6.6-4）：processFile 解析 CSV，processRows 处理已解析的行。ANZ 对账单（R1C）解析后也接 processRows
// 不含数据库：去重跳过（R4.2）、pending 匹配（R8）、R6.2 配对、R6.3 建议、R9 对账都在 M3 的事务里做
// 纯函数，不 import 数据库和 Next.js
import { classify } from '@/lib/rules/classify';
import { assignOccurrences, dedupeKey } from '@/lib/rules/dedupe';
import { extractAndMask } from '@/lib/rules/extract';
import { resolveMember } from '@/lib/rules/member';
import { cleanMerchant } from '@/lib/rules/merchant';
import { detectTransfer } from '@/lib/rules/transfer';
import type {
  Account,
  Card,
  Category,
  CategoryRule,
  ParsedRow,
  ProcessedRow,
} from '@/lib/rules/types';
import { parseBankCsv } from './index';

// 处理需要的家庭配置
export type HouseholdConfig = {
  accounts: readonly Account[];
  cards: readonly Card[];
  categories: readonly Category[];
  rules: readonly CategoryRule[];
};

// 和 parseBankCsv 一样返回结果对象，Server Action 可以直接显示 message
export type ProcessFileResult =
  { ok: true; rows: ProcessedRow[] } | { ok: false; message: string; line: number | null };

export function processFile(
  text: string,
  account: Account,
  household: HouseholdConfig,
): ProcessFileResult {
  // R1：任意一行出错整个文件失败
  const parsed = parseBankCsv(account.bank, text);
  if (!parsed.ok) return parsed;
  return { ok: true, rows: processRows(parsed.rows, account, household) };
}

// R2 到 R5：CSV（R1A、R1B）和 ANZ 对账单（R1C）解析出来的行共用。行的顺序和文件一致
// 对账单一笔都没有时 rows 是空的，返回空数组（R1C）
export function processRows(
  parsedRows: readonly ParsedRow[],
  account: Account,
  household: HouseholdConfig,
): ProcessedRow[] {
  // R2：先提取再脱敏。对方账号只留在这一步的内存里给 R6.1 用，不进输出
  const extracted = parsedRows.map((row) => {
    const { description, cardLast4, transferAccount } = extractAndMask(row.description);
    return { ...row, description, cardLast4, transferAccount };
  });

  // R4.1：occurrence 在整个文件里按顺序数
  const withOccurrence = assignOccurrences(extracted);

  return withOccurrence.map((row): ProcessedRow => {
    const merchant = cleanMerchant(row.description); // R3

    // R6.1 → R7 → R5
    const transfer = detectTransfer(row, account, household.accounts);
    const category = classify(
      { merchant, isInternalTransfer: transfer.transferStatus === 'auto' },
      household.rules,
      household.categories,
    );
    const member = resolveMember(
      { accountId: account.id, cardLast4: row.cardLast4, categoryId: category.categoryId },
      household,
    );

    return {
      accountId: account.id,
      date: row.date,
      amountCents: row.amountCents,
      balanceCents: row.balanceCents,
      rowIndex: row.rowIndex,

      rawDescription: row.description,
      merchant,
      cardLast4: row.cardLast4,

      occurrence: row.occurrence,
      dedupeKey: dedupeKey(account.id, row, row.occurrence),

      transferStatus: transfer.transferStatus,
      transferAccountId: transfer.transferAccountId,

      categoryId: category.categoryId,
      categorySource: category.categorySource,
      isPreTax: category.isPreTax,

      memberId: member.memberId,
      memberSource: member.memberSource,
    };
  });
}
