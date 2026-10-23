// CSV 导入（business-rules.md R12），第 1 到 10 步
// 业务判断全部用 src/lib/ 的纯函数，这里只负责读写数据库和串流程
// 不保存上传的原文件；日志和报错里不打印原始描述
import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  card,
  category,
  categoryRule,
  financialAccount,
  importBatch,
  transaction,
  transactionSplit,
} from '@/db/schema';
import { canImportCsv } from '@/lib/import/banks';
import { checkBalanceContinuity, deriveBalances, type BalanceWarning } from '@/lib/import/cba';
import { processFile, type HouseholdConfig } from '@/lib/import/process';
import { bySystemKey } from '@/lib/rules/classify';
import { confirmPendingTransfer, findPendingMatches } from '@/lib/rules/pending';
import { pendingsToCheck, reconcile, type Reconciliation } from '@/lib/rules/reconcile';
import {
  planTransfers,
  storedTransferAccountId,
  type HouseholdTransferTx,
  type TransferPlan,
} from '@/lib/rules/transfer';
import type { CategorySource, MemberSource, ParsedRow, ProcessedRow } from '@/lib/rules/types';
import type { HouseholdContext } from './context';

export type ImportInput = {
  accountId: string;
  fileName: string;
  text: string;
  // ANZ 可选，要么都填要么都不填；CBA 忽略，按 R1B.2 自动得出
  openingBalanceCents?: number | null;
  closingBalanceCents?: number | null;
};

// import_batch.warnings（jsonb，不改表）
export type ImportWarnings = {
  balance: BalanceWarning[]; // R1B.1
  possibleDuplicates: { transactionId: string; pendingIds: string[] }[]; // R8.2 ≥ 2 个候选
  pendingTransferSplits: string[]; // R8.3 例外：pending 有多个拆分，没改，F8 提示
  reconciliation: Reconciliation; // R9，差额只能在导入时算准，存下来给结果页
};

// 本次新插入的交易和被确认的 pending
export type ImportedTransaction = {
  id: string;
  kind: 'inserted' | 'confirmed_pending';
  transferAccountId: string | null; // R6.1 匹配到的对方账户，不入库
};

// R8.4 导入结果页要列出的 pending
export type PendingToCheck = { id: string; date: string; amountCents: number; merchant: string };

export type ImportSuccess = {
  ok: true;
  batchId: string;
  rowCount: number;
  insertedCount: number;
  duplicateCount: number;
  matchedPendingCount: number;
  uncategorizedCount: number; // 本批次的交易里，R6 之后主拆分仍是未分类的（suggested 也算）
  pendingToCheck: PendingToCheck[]; // R8.4
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  reconciliation: Reconciliation; // R9
  warnings: ImportWarnings;
  transactions: ImportedTransaction[];
  transfers: TransferPlan; // R6.2 配对、R6.3 建议
};

export type ImportFailure = {
  ok: false;
  reason: 'not_importable' | 'invalid_balance' | 'parse';
  message: string;
  line: number | null;
};

export type ImportResult = ImportSuccess | ImportFailure;

// 一条 INSERT 的行数上限，避开 Postgres 的参数个数限制
const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function fail(
  reason: ImportFailure['reason'],
  message: string,
  line: number | null = null,
): ImportFailure {
  return { ok: false, reason, message, line };
}

const splitCountSql = sql<number>`(select count(*)::int from ${transactionSplit} s where s.transaction_id = ${transaction.id})`;

const primarySplitJoin = and(
  eq(transactionSplit.transactionId, transaction.id),
  eq(transactionSplit.isPrimary, true),
);

// R5、R6.1、R7 要用的家庭配置
// 账户和分类连已归档的一起读：转给已归档账户的钱 R6.1 照样认得出，规则指向已归档分类也不会找不到
async function loadHouseholdConfig(ctx: HouseholdContext): Promise<HouseholdConfig> {
  const hh = ctx.householdId;
  const [accounts, cards, categories, rules] = await Promise.all([
    db
      .select({
        id: financialAccount.id,
        name: financialAccount.name,
        bank: financialAccount.bank,
        type: financialAccount.type,
        defaultMemberId: financialAccount.defaultMemberId,
        numberSuffix: financialAccount.numberSuffix,
      })
      .from(financialAccount)
      .where(eq(financialAccount.householdId, hh)),
    db
      .select({
        id: card.id,
        accountId: card.accountId,
        last4: card.last4,
        memberId: card.memberId,
      })
      .from(card)
      .where(eq(card.householdId, hh)),
    db
      .select({
        id: category.id,
        parentId: category.parentId,
        nameEn: category.nameEn,
        kind: category.kind,
        systemKey: category.systemKey,
        defaultMemberId: category.defaultMemberId,
        isPreTaxDefault: category.isPreTaxDefault,
        isOther: category.isOther,
      })
      .from(category)
      .where(eq(category.householdId, hh)),
    db
      .select({
        id: categoryRule.id,
        keyword: categoryRule.keyword,
        matchType: categoryRule.matchType,
        categoryId: categoryRule.categoryId,
        priority: categoryRule.priority,
        isSystem: categoryRule.isSystem,
        createdAt: categoryRule.createdAt,
      })
      .from(categoryRule)
      .where(eq(categoryRule.householdId, hh)),
  ]);
  return { accounts, cards, categories, rules };
}

// R12：一次导入。解析失败、账户不能导入返回 ok: false，什么都不写；事务里出错直接抛，全部回滚
export async function importCsv(ctx: HouseholdContext, input: ImportInput): Promise<ImportResult> {
  const [target] = await db
    .select({ bank: financialAccount.bank, isArchived: financialAccount.isArchived })
    .from(financialAccount)
    .where(
      and(
        eq(financialAccount.id, input.accountId),
        eq(financialAccount.householdId, ctx.householdId),
      ),
    );
  // R1 表格（P9）：anz_plus、cash、other 不能导入。不存在、已归档的账户同样拒绝
  if (!target) return fail('not_importable', '账户不存在');
  if (target.isArchived) return fail('not_importable', '这个账户已经归档了，不能导入');
  if (!canImportCsv(target.bank)) return fail('not_importable', '这个账户不能导入 CSV');

  const config = await loadHouseholdConfig(ctx);
  const account = config.accounts.find((a) => a.id === input.accountId);
  if (!account) return fail('not_importable', '账户不存在');
  const accountById = new Map(config.accounts.map((a) => [a.id, a]));
  const uncategorized = bySystemKey(config.categories, 'uncategorized');

  // ---------- R12 第 1、2 步：事务外 ----------

  const processed = processFile(input.text, account, config);
  if (!processed.ok) return fail('parse', processed.message, processed.line);
  const rows = processed.rows;

  const balanceWarnings: BalanceWarning[] = [];
  let openingBalanceCents: number | null = null;
  let closingBalanceCents: number | null = null;

  if (account.bank === 'cba') {
    // R1B.1 只记警告；R1B.2 期初期末自动得出，忽略传进来的
    // processFile 的输出和文件顺序一致，只用到日期、金额、余额、行号；描述用脱敏后的
    const parsed: ParsedRow[] = rows.map((r) => ({
      date: r.date,
      amountCents: r.amountCents,
      description: r.rawDescription,
      balanceCents: r.balanceCents,
      rowIndex: r.rowIndex,
    }));
    balanceWarnings.push(...checkBalanceContinuity(parsed));
    ({ openingBalanceCents, closingBalanceCents } = deriveBalances(parsed));
  } else {
    const opening = input.openingBalanceCents ?? null;
    const closing = input.closingBalanceCents ?? null;
    if ((opening === null) !== (closing === null)) {
      return fail('invalid_balance', '期初余额和期末余额要一起填，或者都不填');
    }
    for (const v of [opening, closing]) {
      if (v !== null && !Number.isSafeInteger(v)) {
        return fail('invalid_balance', '余额必须是整数分');
      }
    }
    openingBalanceCents = opening;
    closingBalanceCents = closing;
  }

  // schema.md：文件里最早和最晚日期（YYYY-MM-DD 字符串可以直接比较）
  const dates = rows.map((r) => r.date).sort();
  const dateFrom = dates[0];
  const dateTo = dates[dates.length - 1];

  // ---------- R12 第 3 到 9 步：一个事务 ----------

  return db.transaction(async (tx) => {
    const hh = ctx.householdId;
    const possibleDuplicates: ImportWarnings['possibleDuplicates'] = [];
    const pendingTransferSplits: string[] = [];

    // 4. 创建 import_batch，计数最后再更新
    const [batch] = await tx
      .insert(importBatch)
      .values({
        householdId: hh,
        accountId: account.id,
        fileName: input.fileName,
        dateFrom,
        dateTo,
        rowCount: rows.length,
        insertedCount: 0,
        duplicateCount: 0,
        matchedPendingCount: 0,
        openingBalanceCents,
        closingBalanceCents,
        createdBy: ctx.userId,
      })
      .returning({ id: importBatch.id });

    // ---------- 5. 逐行：去重、pending 匹配、插入 ----------

    // R4.2：(account_id, dedupe_key) 已存在的跳过
    const existing = new Set<string>();
    for (const keys of chunks(rows.map((r) => r.dedupeKey))) {
      const found = await tx
        .select({ key: transaction.dedupeKey })
        .from(transaction)
        .where(
          and(
            eq(transaction.householdId, hh),
            eq(transaction.accountId, account.id),
            inArray(transaction.dedupeKey, keys),
          ),
        );
      for (const f of found) if (f.key) existing.add(f.key);
    }
    const fresh = rows.filter((r) => !existing.has(r.dedupeKey));
    const duplicateCount = rows.length - fresh.length;

    // R8.2：同账户的 pending，带上拆分数和主拆分的归属人（R8.3 例外要用）
    const pendings = await tx
      .select({
        id: transaction.id,
        accountId: transaction.accountId,
        date: transaction.date,
        amountCents: transaction.amountCents,
        memberId: transactionSplit.memberId,
        memberSource: transactionSplit.memberSource,
        splitCount: splitCountSql,
      })
      .from(transaction)
      .innerJoin(transactionSplit, primarySplitJoin)
      .where(
        and(
          eq(transaction.householdId, hh),
          eq(transaction.accountId, account.id),
          eq(transaction.status, 'pending'),
        ),
      );
    const pendingById = new Map(pendings.map((p) => [p.id, p]));
    const matches = findPendingMatches(fresh, account.id, pendings);

    const toInsert: { id: string; row: ProcessedRow }[] = [];
    const transactions: ImportedTransaction[] = [];
    let matchedPendingCount = 0;

    for (const [i, row] of fresh.entries()) {
      const match = matches[i];

      if (match.kind === 'match') {
        // R8.3：确认 pending，不插入新交易。拆分保留用户录入的，source 保留 manual
        const pending = pendingById.get(match.pendingId)!;
        const exception = confirmPendingTransfer(
          row,
          {
            splitCount: pending.splitCount,
            primaryMember: {
              memberId: pending.memberId,
              memberSource: pending.memberSource as MemberSource,
            },
          },
          config,
        );

        await tx
          .update(transaction)
          .set({
            status: 'confirmed',
            date: row.date,
            rawDescription: row.rawDescription,
            merchant: row.merchant,
            cardLast4: row.cardLast4,
            dedupeKey: row.dedupeKey,
            importBatchId: batch.id,
            confirmedAt: sql`now()`,
            // R8.3 例外：R6.1 认出是内部转账
            ...(exception.kind === 'transfer' ? { transferStatus: exception.transferStatus } : {}),
          })
          .where(and(eq(transaction.id, pending.id), eq(transaction.householdId, hh)));

        if (exception.kind === 'transfer') {
          await tx
            .update(transactionSplit)
            .set(exception.primarySplit)
            .where(
              and(
                eq(transactionSplit.transactionId, pending.id),
                eq(transactionSplit.householdId, hh),
                eq(transactionSplit.isPrimary, true),
              ),
            );
        } else if (exception.kind === 'multiple_splits') {
          // transfer_status 保持 none：另一半导入时如果是 auto，R6.2 照样能找到它（manual，只配对不改）
          pendingTransferSplits.push(pending.id);
        }

        matchedPendingCount++;
        transactions.push({
          id: pending.id,
          kind: 'confirmed_pending',
          transferAccountId: exception.kind === 'not_transfer' ? null : exception.transferAccountId,
        });
        continue;
      }

      // 0 个或 ≥ 2 个候选：正常插入。id 先生成，批量插入时不用依赖 RETURNING 的顺序
      const id = randomUUID();
      toInsert.push({ id, row });
      transactions.push({ id, kind: 'inserted', transferAccountId: row.transferAccountId });
      if (match.kind === 'ambiguous') {
        possibleDuplicates.push({ transactionId: id, pendingIds: match.pendingIds });
      }
    }

    // 新交易：transaction（CBA 带 balance_cents）+ 一行主拆分
    for (const part of chunks(toInsert)) {
      await tx.insert(transaction).values(
        part.map(({ id, row }) => ({
          id,
          householdId: hh,
          accountId: account.id,
          date: row.date,
          amountCents: row.amountCents,
          rawDescription: row.rawDescription,
          merchant: row.merchant,
          cardLast4: row.cardLast4,
          balanceCents: row.balanceCents,
          status: 'confirmed' as const,
          source: 'csv' as const,
          transferStatus: row.transferStatus,
          dedupeKey: row.dedupeKey,
          importBatchId: batch.id,
          createdBy: ctx.userId,
        })),
      );
    }
    for (const part of chunks(toInsert)) {
      await tx.insert(transactionSplit).values(
        part.map(({ id, row }) => ({
          householdId: hh,
          transactionId: id,
          amountCents: row.amountCents,
          categoryId: row.categoryId,
          memberId: row.memberId,
          categorySource: row.categorySource,
          memberSource: row.memberSource,
          isPrimary: true,
          isPreTax: row.isPreTax,
        })),
      );
    }

    // ---------- 6. R6.2 配对（整个家庭）、R6.3 兜底建议 ----------

    // 整个家庭还没配对的 confirmed 交易（pending 不参与，等它被导入确认时再检查）
    const unpaired = await tx
      .select({
        id: transaction.id,
        accountId: transaction.accountId,
        date: transaction.date,
        amountCents: transaction.amountCents,
        rawDescription: transaction.rawDescription,
        cardLast4: transaction.cardLast4,
        transferStatus: transaction.transferStatus,
        categoryId: transactionSplit.categoryId,
        categorySource: transactionSplit.categorySource,
        memberId: transactionSplit.memberId,
        memberSource: transactionSplit.memberSource,
        splitCount: splitCountSql,
      })
      .from(transaction)
      .innerJoin(transactionSplit, primarySplitJoin)
      .where(
        and(
          eq(transaction.householdId, hh),
          eq(transaction.status, 'confirmed'),
          isNull(transaction.transferPairId),
        ),
      );

    // 本次的交易用内存里 R6.1 的结果；以前导入的 auto 转账从脱敏后的描述重认
    const knownTransferAccount = new Map(transactions.map((t) => [t.id, t.transferAccountId]));
    const householdTxs: HouseholdTransferTx[] = unpaired.map((t) => ({
      id: t.id,
      accountId: t.accountId,
      date: t.date,
      amountCents: t.amountCents,
      transferStatus: t.transferStatus,
      transferAccountId: knownTransferAccount.has(t.id)
        ? knownTransferAccount.get(t.id)!
        : t.transferStatus === 'auto'
          ? storedTransferAccountId(
              t.rawDescription,
              accountById.get(t.accountId)!,
              config.accounts,
            )
          : null,
      transferPairId: null,
      categoryId: t.categoryId,
      categorySource: t.categorySource as CategorySource,
      splitCount: t.splitCount,
      cardLast4: t.cardLast4,
      memberId: t.memberId,
      memberSource: t.memberSource as MemberSource,
    }));

    const newIds = new Set(toInsert.map((t) => t.id));
    const transfers = planTransfers(householdTxs, newIds, config);

    const byId = (id: string) => and(eq(transaction.id, id), eq(transaction.householdId, hh));
    for (const p of transfers.pairs) {
      await tx.update(transaction).set({ transferPairId: p.bId }).where(byId(p.aId));
      const u = p.counterpartUpdate;
      await tx
        .update(transaction)
        .set({ transferPairId: p.aId, ...(u ? { transferStatus: u.transferStatus } : {}) })
        .where(byId(p.bId));
      if (u) {
        await tx
          .update(transactionSplit)
          .set({
            categoryId: u.categoryId,
            categorySource: u.categorySource,
            isPreTax: u.isPreTax,
            memberId: u.memberId,
            memberSource: u.memberSource,
          })
          .where(
            and(
              eq(transactionSplit.transactionId, p.bId),
              eq(transactionSplit.householdId, hh),
              eq(transactionSplit.isPrimary, true),
            ),
          );
      }
    }
    // R6.3：两边都标 suggested 并配对，分类和归属人不动（确认前还是未分类）
    for (const s of transfers.suggestions) {
      await tx
        .update(transaction)
        .set({ transferStatus: 'suggested', transferPairId: s.bId })
        .where(byId(s.aId));
      await tx
        .update(transaction)
        .set({ transferStatus: 'suggested', transferPairId: s.aId })
        .where(byId(s.bId));
    }

    // ---------- 7. R9 对账：用数据库里该账户的交易，不只是本次文件 ----------

    const inRange = await tx
      .select({
        date: transaction.date,
        amountCents: transaction.amountCents,
        status: transaction.status,
      })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, hh),
          eq(transaction.accountId, account.id),
          gte(transaction.date, dateFrom),
          lte(transaction.date, dateTo),
        ),
      );
    const reconciliation = reconcile({
      openingBalanceCents,
      closingBalanceCents,
      dateFrom,
      dateTo,
      transactions: inRange,
    });

    // ---------- 8. 更新 import_batch ----------

    const warnings: ImportWarnings = {
      balance: balanceWarnings,
      possibleDuplicates,
      pendingTransferSplits,
      reconciliation,
    };
    await tx
      .update(importBatch)
      .set({
        insertedCount: toInsert.length,
        duplicateCount,
        matchedPendingCount,
        reconciled: reconciliation.status === 'none' ? null : reconciliation.status === 'passed',
        warnings,
      })
      .where(eq(importBatch.id, batch.id));

    // ---------- 10. 返回结果 ----------

    const batchIds = transactions.map((t) => t.id);
    const uncategorizedCount =
      batchIds.length === 0
        ? 0
        : await tx.$count(
            transactionSplit,
            and(
              eq(transactionSplit.householdId, hh),
              eq(transactionSplit.isPrimary, true),
              eq(transactionSplit.categoryId, uncategorized.id),
              inArray(transactionSplit.transactionId, batchIds),
            ),
          );

    // R8.4：该账户里还是 pending 的
    const stillPending = await tx
      .select({
        id: transaction.id,
        date: transaction.date,
        amountCents: transaction.amountCents,
        merchant: transaction.merchant,
        status: transaction.status,
      })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, hh),
          eq(transaction.accountId, account.id),
          eq(transaction.status, 'pending'),
        ),
      )
      .orderBy(transaction.date);
    const pendingToCheck = pendingsToCheck(stillPending, dateTo).map(
      ({ id, date, amountCents, merchant }) => ({ id, date, amountCents, merchant }),
    );

    return {
      ok: true,
      batchId: batch.id,
      rowCount: rows.length,
      insertedCount: toInsert.length,
      duplicateCount,
      matchedPendingCount,
      uncategorizedCount,
      pendingToCheck,
      openingBalanceCents,
      closingBalanceCents,
      reconciliation,
      warnings,
      transactions,
      transfers,
    } satisfies ImportSuccess;
  });
}
