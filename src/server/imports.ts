// CSV 和 ANZ PDF 对账单导入（business-rules.md R12、R1C），第 1 到 10 步；导入结果页（M3-8）；撤销导入（R12.1）
// 业务判断全部用 src/lib/ 的纯函数，这里只负责读写数据库和串流程
// 不保存上传的原文件；日志和报错里不打印原始描述
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  card,
  category,
  categoryRule,
  financialAccount,
  importBatch,
  member,
  transaction,
  transactionSplit,
} from '@/db/schema';
import type { Bank } from '@/lib/accounts/account-input';
import { canImportCsv } from '@/lib/import/banks';
import { parseAnzStatement, type StatementLine } from '@/lib/import/anz-statement';
import { checkBalanceContinuity, deriveBalances, type BalanceWarning } from '@/lib/import/cba';
import {
  csvGapWarning,
  importCoverage,
  type ImportCoverage,
  type ImportGap,
} from '@/lib/import/coverage';
import { checkPdfFile } from '@/lib/import/import-input';
import { processFile, processRows, type HouseholdConfig } from '@/lib/import/process';
import { addDays, todayInMelbourne } from '@/lib/rules/periods';
import { bySystemKey } from '@/lib/rules/classify';
import { confirmPendingTransfer, findPendingMatches } from '@/lib/rules/pending';
import { pendingsToCheck, reconcile, type Reconciliation } from '@/lib/rules/reconcile';
import type { TransferPlan } from '@/lib/rules/transfer';
import type {
  CategorySource,
  MemberSource,
  ParsedRow,
  ProcessedRow,
  TransferStatus,
} from '@/lib/rules/types';
import {
  planUndo,
  type CounterpartPlan,
  type UndoBatchTx,
  type UndoCounterpart,
  type UndoPlan,
} from '@/lib/rules/undo';
import type { HouseholdContext } from './context';
import { extractPdfLines } from './pdf/text';
import { pairHouseholdTransfers, primarySplitJoin, splitCountSql } from './transfers';

export type ImportInput = {
  accountId: string;
  fileName: string;
  text: string;
  // ANZ 可选，要么都填要么都不填；CBA 忽略，按 R1B.2 自动得出
  openingBalanceCents?: number | null;
  closingBalanceCents?: number | null;
};

// ANZ 对账单（R1C）：buffer 是上传的 PDF，只在内存里读，不保存
export type ImportStatementInput = {
  accountId: string;
  fileName: string;
  buffer: ArrayBuffer | Uint8Array;
};

// 读出文字以后的那一步，测试直接用 fixture 的行
export type ImportStatementLinesInput = {
  accountId: string;
  fileName: string;
  lines: readonly StatementLine[];
};

// R12.2 首尾衔接：上一份对账单（同账户、source = pdf、date_to 比本次早的里面最大的）
export type PreviousStatement = { batchId: string; dateFrom: string; dateTo: string };
export type StatementContinuity =
  | { status: 'connected'; previous: PreviousStatement } // 上一份的期末 = 本次的期初
  | { status: 'mismatch'; previous: PreviousStatement; differenceCents: number } // 本次期初 − 上一份期末
  | null; // 没有上一份，不提示

// import_batch.warnings（jsonb，不改表）
export type ImportWarnings = {
  balance: BalanceWarning[]; // R1B.1
  possibleDuplicates: { transactionId: string; pendingIds: string[] }[]; // R8.2 ≥ 2 个候选
  pendingTransferSplits: string[]; // R8.3 例外：pending 有多个拆分，没改，F8 提示
  reconciliation: Reconciliation; // R9，差额只能在导入时算准，存下来给结果页
  statementContinuity?: StatementContinuity; // R12.2，只有 PDF 批次有
  importGap?: ImportGap; // R12.2，只有 CSV 批次、和以前的导入没有重叠时才有
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
  // invalid_file：对账单不是 .pdf、太大、是空的
  reason: 'not_importable' | 'invalid_balance' | 'invalid_file' | 'parse';
  message: string;
  line: number | null;
  // R1C：对账单出错的交易在第几页第几笔
  page?: number | null;
  index?: number | null;
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

type ImportTarget = {
  config: HouseholdConfig;
  account: HouseholdConfig['accounts'][number];
};

// R1 表格（P9）：按账户的银行判断能不能导入。不存在、已归档的账户同样拒绝
async function loadImportTarget(
  ctx: HouseholdContext,
  accountId: string,
  kind: 'csv' | 'pdf',
): Promise<ImportTarget | ImportFailure> {
  const [target] = await db
    .select({ bank: financialAccount.bank, isArchived: financialAccount.isArchived })
    .from(financialAccount)
    .where(
      and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)),
    );
  if (!target) return fail('not_importable', '账户不存在');
  if (target.isArchived) return fail('not_importable', '这个账户已经归档了，不能导入');
  if (kind === 'csv' && !canImportCsv(target.bank)) {
    return fail('not_importable', '这个账户不能导入 CSV');
  }
  // R1C：只有 ANZ 有对账单解析器
  if (kind === 'pdf' && target.bank !== 'anz') {
    return fail('not_importable', '只有 ANZ 账户能导入 PDF 对账单');
  }

  const config = await loadHouseholdConfig(ctx);
  const account = config.accounts.find((a) => a.id === accountId);
  if (!account) return fail('not_importable', '账户不存在');
  return { config, account };
}

// R12 第 1、2 步做完以后，交给事务的东西
type PreparedImport = ImportTarget & {
  fileName: string;
  source: 'csv' | 'pdf';
  rows: ProcessedRow[];
  dateFrom: string;
  dateTo: string;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  balanceWarnings: BalanceWarning[];
};

// R12：一次导入。解析失败、账户不能导入返回 ok: false，什么都不写；事务里出错直接抛，全部回滚
export async function importCsv(ctx: HouseholdContext, input: ImportInput): Promise<ImportResult> {
  const target = await loadImportTarget(ctx, input.accountId, 'csv');
  if ('ok' in target) return target;
  const { config, account } = target;

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

  // schema.md：文件里最早和最晚日期（YYYY-MM-DD 字符串可以直接比较）。CSV 至少有一行（R1）
  const dates = rows.map((r) => r.date).sort();

  return runImport(ctx, {
    config,
    account,
    fileName: input.fileName,
    source: 'csv',
    rows,
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    openingBalanceCents,
    closingBalanceCents,
    balanceWarnings,
  });
}

// R1C：ANZ PDF 对账单。文件检查 → 读文字 → 和 CSV 一样的处理和事务
export async function importStatement(
  ctx: HouseholdContext,
  input: ImportStatementInput,
): Promise<ImportResult> {
  const fileError = checkPdfFile({ name: input.fileName, size: input.buffer.byteLength });
  if (fileError) return fail('invalid_file', fileError);

  // 先看账户，不是 ANZ 就不用读 PDF
  const target = await loadImportTarget(ctx, input.accountId, 'pdf');
  if ('ok' in target) return target;

  // R1C 第一层：读不出文字（扫描件、加密的、不是 PDF）
  const extracted = await extractPdfLines(input.buffer);
  if (!extracted.ok) return fail('parse', extracted.message);

  return importStatementLines(ctx, {
    accountId: input.accountId,
    fileName: input.fileName,
    lines: extracted.lines,
  });
}

// R1C 第二层以后：解析 → R2 到 R5（processRows）→ R12 第 3 到 9 步
export async function importStatementLines(
  ctx: HouseholdContext,
  input: ImportStatementLinesInput,
): Promise<ImportResult> {
  const target = await loadImportTarget(ctx, input.accountId, 'pdf');
  if ('ok' in target) return target;
  const { config, account } = target;

  // R1C：表头、账号尾号、三项检查，任何一条不过整份失败。账号尾号核对在解析里做，不存
  const parsed = parseAnzStatement(input.lines, account.numberSuffix);
  if (!parsed.ok) {
    // 信息里已经写了第几页第几笔
    return { ...fail('parse', parsed.message), page: parsed.page, index: parsed.index };
  }

  return runImport(ctx, {
    config,
    account,
    fileName: input.fileName,
    source: 'pdf',
    rows: processRows(parsed.rows, account, config),
    // R1C：账期是 (periodFrom, periodTo]，R9 照旧按 [date_from, date_to] 算
    dateFrom: addDays(parsed.periodFrom, 1),
    dateTo: parsed.periodTo,
    // R9：期初期末从汇总页来
    openingBalanceCents: parsed.openingCents,
    closingBalanceCents: parsed.closingCents,
    balanceWarnings: [],
  });
}

// R12.2 首尾衔接：同账户上一份对账单（source = pdf，date_to 比本次早的里面最大的）
async function findStatementContinuity(
  tx: Tx,
  ctx: HouseholdContext,
  accountId: string,
  dateTo: string,
  openingBalanceCents: number | null,
): Promise<StatementContinuity> {
  const [previous] = await tx
    .select({
      batchId: importBatch.id,
      dateFrom: importBatch.dateFrom,
      dateTo: importBatch.dateTo,
      closingBalanceCents: importBatch.closingBalanceCents,
    })
    .from(importBatch)
    .where(
      and(
        eq(importBatch.householdId, ctx.householdId),
        eq(importBatch.accountId, accountId),
        eq(importBatch.source, 'pdf'),
        lt(importBatch.dateTo, dateTo),
      ),
    )
    .orderBy(desc(importBatch.dateTo), desc(importBatch.createdAt))
    .limit(1);
  // 对账单批次都有期初期末（R1C），防御一下
  if (!previous || previous.closingBalanceCents === null || openingBalanceCents === null) {
    return null;
  }
  const prev = { batchId: previous.batchId, dateFrom: previous.dateFrom, dateTo: previous.dateTo };
  const differenceCents = openingBalanceCents - previous.closingBalanceCents;
  return differenceCents === 0
    ? { status: 'connected', previous: prev }
    : { status: 'mismatch', previous: prev, differenceCents };
}

// R12.2：这个账户所有导入批次的来源和 date_to
async function loadCoverageBatches(q: Tx | typeof db, ctx: HouseholdContext, accountId: string) {
  return q
    .select({ source: importBatch.source, dateTo: importBatch.dateTo })
    .from(importBatch)
    .where(and(eq(importBatch.householdId, ctx.householdId), eq(importBatch.accountId, accountId)))
    .then((rows) => rows.map((r) => ({ source: r.source as 'csv' | 'pdf', dateTo: r.dateTo })));
}

// R12.2 导入前：上次导到哪天、建议导出范围、对账单导到哪天。账户不属于这个家庭时和没导入过一样
export async function getImportCoverage(
  ctx: HouseholdContext,
  accountId: string,
  today: string = todayInMelbourne(),
): Promise<ImportCoverage> {
  return importCoverage(await loadCoverageBatches(db, ctx, accountId), today);
}

// ---------- R12 第 3 到 9 步：一个事务。CSV 和对账单共用 ----------
async function runImport(ctx: HouseholdContext, p: PreparedImport): Promise<ImportSuccess> {
  const { config, account, rows, dateFrom, dateTo, openingBalanceCents, closingBalanceCents } = p;
  const uncategorized = bySystemKey(config.categories, 'uncategorized');

  return db.transaction(async (tx) => {
    const hh = ctx.householdId;
    const possibleDuplicates: ImportWarnings['possibleDuplicates'] = [];
    const pendingTransferSplits: string[] = [];

    // R12.2：在创建本次批次之前找，免得找到自己
    // PDF：首尾衔接。CSV：和这个账户所有批次（CSV、PDF）里最大的 date_to 比，没有重叠就警告
    const statementContinuity =
      p.source === 'pdf'
        ? await findStatementContinuity(tx, ctx, account.id, dateTo, openingBalanceCents)
        : undefined;
    const importGap =
      p.source === 'csv'
        ? csvGapWarning(
            dateFrom,
            importCoverage(await loadCoverageBatches(tx, ctx, account.id), todayInMelbourne())
              .lastDateTo,
          )
        : null;

    // 4. 创建 import_batch，计数最后再更新
    const [batch] = await tx
      .insert(importBatch)
      .values({
        householdId: hh,
        accountId: account.id,
        fileName: p.fileName,
        source: p.source,
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

    // R4.2：(account_id, dedupe_key) 已存在的跳过。对账单一笔都没有时 rows 是空的（R1C）
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

    // 新交易：transaction（CBA 带 balance_cents，对账单的余额 R1C 不存，解析出来就是 null）+ 一行主拆分
    // source：CSV 和对账单进来的都是 csv（银行导入），批次的来源看 import_batch.source（M6.6-4 定）
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

    // 本次的交易用内存里 R6.1 的结果；以前导入的 auto 转账从脱敏后的描述重认
    const newIds = new Set(toInsert.map((t) => t.id));
    const knownTransferAccount = new Map(transactions.map((t) => [t.id, t.transferAccountId]));
    const transfers = await pairHouseholdTransfers(tx, ctx, config, {
      newIds,
      knownTransferAccount,
    });

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
      balance: p.balanceWarnings,
      possibleDuplicates,
      pendingTransferSplits,
      reconciliation,
      // CSV 批次不带这个字段
      ...(statementContinuity === undefined ? {} : { statementContinuity }),
      // 没有空档就不带这个字段
      ...(importGap === null ? {} : { importGap }),
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

// ==================== M3-8 导入结果页 ====================

// 可能重复（R8.2 ≥ 2 个候选）里的一笔
export type ResultTx = { id: string; date: string; amountCents: number; merchant: string };

// R8.4 待检查的 pending，带归属人和备注方便用户认出是哪一笔
export type ResultPending = PendingToCheck & { memberName: string; note: string | null };

export type ImportResultView = {
  batchId: string;
  fileName: string;
  createdAt: Date;
  account: { id: string; name: string; bank: Bank; numberSuffix: string | null };
  source: 'csv' | 'pdf'; // pdf = ANZ 对账单（R1C）
  dateFrom: string;
  dateTo: string;
  rowCount: number;
  insertedCount: number;
  duplicateCount: number;
  matchedPendingCount: number;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  // 导入时存下来的（差额只有导入时算得准）
  reconciliation: Reconciliation;
  balanceWarnings: BalanceWarning[];
  statementContinuity: StatementContinuity; // R12.2 首尾衔接，CSV 是 null
  importGap: ImportGap | null; // R12.2 CSV 和上次之间可能有空档
  // 现在的状态：用户之后分了类、确认了 pending，数字会跟着变
  uncategorizedCount: number;
  pendingToCheck: ResultPending[];
  possibleDuplicates: { transaction: ResultTx; pendings: ResultTx[] }[];
  // R12.1：是不是该账户最近一次导入（只有最近一次能撤销）
  canUndo: boolean;
};

const NO_RECONCILIATION: Reconciliation = { status: 'none', differenceCents: null };

// R12 第 10 步的结果，给 /import/[batchId]。不存在或不属于这个家庭返回 null
export async function getImportResult(
  ctx: HouseholdContext,
  batchId: string,
): Promise<ImportResultView | null> {
  const hh = ctx.householdId;
  const [batch] = await db
    .select({
      id: importBatch.id,
      fileName: importBatch.fileName,
      createdAt: importBatch.createdAt,
      source: importBatch.source,
      dateFrom: importBatch.dateFrom,
      dateTo: importBatch.dateTo,
      rowCount: importBatch.rowCount,
      insertedCount: importBatch.insertedCount,
      duplicateCount: importBatch.duplicateCount,
      matchedPendingCount: importBatch.matchedPendingCount,
      openingBalanceCents: importBatch.openingBalanceCents,
      closingBalanceCents: importBatch.closingBalanceCents,
      warnings: importBatch.warnings,
      accountId: financialAccount.id,
      accountName: financialAccount.name,
      bank: financialAccount.bank,
      numberSuffix: financialAccount.numberSuffix,
    })
    .from(importBatch)
    .innerJoin(financialAccount, eq(financialAccount.id, importBatch.accountId))
    .where(and(eq(importBatch.id, batchId), eq(importBatch.householdId, hh)));
  if (!batch) return null;

  const warnings = (batch.warnings ?? {}) as Partial<ImportWarnings>;

  const [[{ uncategorizedCount }], stillPending, duplicateTxs, newerCount] = await Promise.all([
    // 本批次的交易（新增 + 确认的 pending）里，主拆分现在还是未分类的
    db
      .select({ uncategorizedCount: sql<number>`count(*)::int` })
      .from(transaction)
      .innerJoin(transactionSplit, primarySplitJoin)
      .innerJoin(category, eq(category.id, transactionSplit.categoryId))
      .where(
        and(
          eq(transaction.householdId, hh),
          eq(transaction.importBatchId, batch.id),
          eq(category.systemKey, 'uncategorized'),
        ),
      ),
    // R8.4：该账户现在还是 pending 的
    db
      .select({
        id: transaction.id,
        date: transaction.date,
        amountCents: transaction.amountCents,
        merchant: transaction.merchant,
        status: transaction.status,
        note: transaction.note,
        memberName: member.name,
      })
      .from(transaction)
      .innerJoin(transactionSplit, primarySplitJoin)
      .innerJoin(member, eq(member.id, transactionSplit.memberId))
      .where(
        and(
          eq(transaction.householdId, hh),
          eq(transaction.accountId, batch.accountId),
          eq(transaction.status, 'pending'),
        ),
      )
      .orderBy(transaction.date, transaction.id),
    // 可能重复：导入时记下的 id，之后被删掉的就不显示
    (async () => {
      const ids = (warnings.possibleDuplicates ?? []).flatMap((d) => [
        d.transactionId,
        ...d.pendingIds,
      ]);
      if (ids.length === 0) return [];
      return db
        .select({
          id: transaction.id,
          date: transaction.date,
          amountCents: transaction.amountCents,
          merchant: transaction.merchant,
        })
        .from(transaction)
        .where(and(eq(transaction.householdId, hh), inArray(transaction.id, ids)));
    })(),
    // R12.1：该账户之后还有没有导入，和 loadUndoState 的判断一样
    db.$count(
      importBatch,
      and(
        eq(importBatch.householdId, hh),
        eq(importBatch.accountId, batch.accountId),
        ne(importBatch.id, batch.id),
        gt(importBatch.createdAt, batch.createdAt),
      ),
    ),
  ]);

  const txById = new Map(duplicateTxs.map((x) => [x.id, x]));
  const possibleDuplicates = (warnings.possibleDuplicates ?? []).flatMap((d) => {
    const tx = txById.get(d.transactionId);
    if (!tx) return [];
    const pendings = d.pendingIds.flatMap((id) => txById.get(id) ?? []);
    return [{ transaction: tx, pendings }];
  });

  return {
    batchId: batch.id,
    fileName: batch.fileName,
    createdAt: batch.createdAt,
    account: {
      id: batch.accountId,
      name: batch.accountName,
      bank: batch.bank,
      numberSuffix: batch.numberSuffix,
    },
    source: batch.source as 'csv' | 'pdf',
    dateFrom: batch.dateFrom,
    dateTo: batch.dateTo,
    rowCount: batch.rowCount,
    insertedCount: batch.insertedCount,
    duplicateCount: batch.duplicateCount,
    matchedPendingCount: batch.matchedPendingCount,
    openingBalanceCents: batch.openingBalanceCents,
    closingBalanceCents: batch.closingBalanceCents,
    reconciliation: warnings.reconciliation ?? NO_RECONCILIATION,
    balanceWarnings: warnings.balance ?? [],
    statementContinuity: warnings.statementContinuity ?? null,
    importGap: warnings.importGap ?? null,
    uncategorizedCount,
    pendingToCheck: pendingsToCheck(stillPending, batch.dateTo).map(
      ({ id, date, amountCents, merchant, memberName, note }) => ({
        id,
        date,
        amountCents,
        merchant,
        memberName,
        note,
      }),
    ),
    possibleDuplicates,
    canUndo: newerCount === 0,
  };
}

// ==================== 导入历史（M3-9） ====================

export type ImportHistoryRow = {
  batchId: string;
  createdAt: Date;
  fileName: string;
  account: { id: string; name: string; bank: Bank; numberSuffix: string | null };
  source: 'csv' | 'pdf'; // pdf = ANZ 对账单（R1C）
  dateFrom: string;
  dateTo: string;
  insertedCount: number;
  duplicateCount: number;
  matchedPendingCount: number;
  reconciliation: Reconciliation;
  // R12.1：每个账户只有最近一次导入能撤销
  canUndo: boolean;
};

// 家庭的所有导入批次，最新的在前
export async function listImportHistory(ctx: HouseholdContext): Promise<ImportHistoryRow[]> {
  const rows = await db
    .select({
      id: importBatch.id,
      createdAt: importBatch.createdAt,
      fileName: importBatch.fileName,
      source: importBatch.source,
      dateFrom: importBatch.dateFrom,
      dateTo: importBatch.dateTo,
      insertedCount: importBatch.insertedCount,
      duplicateCount: importBatch.duplicateCount,
      matchedPendingCount: importBatch.matchedPendingCount,
      warnings: importBatch.warnings,
      accountId: financialAccount.id,
      accountName: financialAccount.name,
      bank: financialAccount.bank,
      numberSuffix: financialAccount.numberSuffix,
    })
    .from(importBatch)
    .innerJoin(financialAccount, eq(financialAccount.id, importBatch.accountId))
    .where(eq(importBatch.householdId, ctx.householdId))
    .orderBy(desc(importBatch.createdAt), desc(importBatch.id));

  // 和 loadUndoState 一样：该账户没有更晚的批次就能撤销。
  // 已经按数据库的 created_at（微秒）倒序，每个账户第一次出现的就是最近一次；不用 JS Date 比（只到毫秒）
  const seenAccounts = new Set<string>();

  return rows.map((r) => {
    const canUndo = !seenAccounts.has(r.accountId);
    seenAccounts.add(r.accountId);
    const warnings = (r.warnings ?? {}) as Partial<ImportWarnings>;
    return {
      batchId: r.id,
      createdAt: r.createdAt,
      fileName: r.fileName,
      account: { id: r.accountId, name: r.accountName, bank: r.bank, numberSuffix: r.numberSuffix },
      source: r.source as 'csv' | 'pdf',
      dateFrom: r.dateFrom,
      dateTo: r.dateTo,
      insertedCount: r.insertedCount,
      duplicateCount: r.duplicateCount,
      matchedPendingCount: r.matchedPendingCount,
      reconciliation: warnings.reconciliation ?? NO_RECONCILIATION,
      canUndo,
    };
  });
}

// ==================== R12.1 撤销导入 ====================

export type UndoFailure = {
  ok: false;
  // not_found：批次不存在或不属于这个家庭；not_latest：不是该账户最近一次导入
  reason: 'not_found' | 'not_latest';
  message: string;
};

// 撤销弹窗要显示的内容（M3-9）。prompt.needsConfirm = false 时直接撤销
export type UndoPreview =
  | {
      ok: true;
      batchId: string;
      accountId: string;
      fileName: string;
      deleteCount: number; // 本批次插入、撤销时删除的
      prompt: UndoPlan['prompt']; // 手动改过几笔、确认的 pending 几笔
    }
  | UndoFailure;

export type UndoResult =
  | {
      ok: true;
      batchId: string;
      deletedCount: number;
      restoredPendingCount: number;
      counterparts: CounterpartPlan[]; // 配对的另一半怎么处理的
    }
  | UndoFailure;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type UndoState = {
  batch: { id: string; accountId: string; fileName: string };
  batchTxs: UndoBatchTx[];
  plan: UndoPlan;
};

// 读出批次、判断能不能撤销、算 planUndo。lock = true 时锁住批次行，防止同时撤销两次
async function loadUndoState(
  tx: Tx,
  ctx: HouseholdContext,
  batchId: string,
  lock: boolean,
): Promise<UndoState | UndoFailure> {
  const hh = ctx.householdId;
  const batchQuery = tx
    .select({
      id: importBatch.id,
      accountId: importBatch.accountId,
      fileName: importBatch.fileName,
      createdAt: importBatch.createdAt,
    })
    .from(importBatch)
    .where(and(eq(importBatch.id, batchId), eq(importBatch.householdId, hh)));
  const [batch] = lock ? await batchQuery.for('update') : await batchQuery;
  if (!batch) return { ok: false, reason: 'not_found', message: '这次导入不存在，可能已经撤销了' };

  // R12.1：每个账户只能撤销最近一次导入
  const newer = await tx.$count(
    importBatch,
    and(
      eq(importBatch.householdId, hh),
      eq(importBatch.accountId, batch.accountId),
      ne(importBatch.id, batch.id),
      gt(importBatch.createdAt, batch.createdAt),
    ),
  );
  if (newer > 0) {
    return {
      ok: false,
      reason: 'not_latest',
      message: '这个账户之后还有导入，只能撤销最近一次',
    };
  }

  // 本批次的交易：source = csv 的是插入的（要删除，对账单插入的也是 csv），其余是被确认的 pending（要恢复）
  const txs = await tx
    .select({
      id: transaction.id,
      source: transaction.source,
      transferPairId: transaction.transferPairId,
      note: transaction.note,
    })
    .from(transaction)
    .where(and(eq(transaction.householdId, hh), eq(transaction.importBatchId, batch.id)))
    .orderBy(transaction.date, transaction.id);
  const splits = await tx
    .select({
      transactionId: transactionSplit.transactionId,
      categorySource: transactionSplit.categorySource,
      memberSource: transactionSplit.memberSource,
      note: transactionSplit.note,
    })
    .from(transactionSplit)
    .innerJoin(transaction, eq(transaction.id, transactionSplit.transactionId))
    .where(
      and(
        eq(transactionSplit.householdId, hh),
        eq(transaction.householdId, hh),
        eq(transaction.importBatchId, batch.id),
      ),
    );
  const splitsByTx = new Map<string, UndoBatchTx['splits'][number][]>();
  for (const sp of splits) {
    const list = splitsByTx.get(sp.transactionId) ?? [];
    list.push({
      categorySource: sp.categorySource as CategorySource,
      memberSource: sp.memberSource as MemberSource,
      note: sp.note,
    });
    splitsByTx.set(sp.transactionId, list);
  }
  const batchTxs: UndoBatchTx[] = txs.map((t) => ({
    id: t.id,
    transferPairId: t.transferPairId,
    wasPending: t.source !== 'csv',
    note: t.note,
    splits: splitsByTx.get(t.id) ?? [],
  }));

  // 配对的另一半（不在本批次里）
  const inBatch = new Set(batchTxs.map((t) => t.id));
  const counterpartIds = [
    ...new Set(
      batchTxs
        .map((t) => t.transferPairId)
        .filter((id): id is string => id !== null && !inBatch.has(id)),
    ),
  ];
  const counterpartRows =
    counterpartIds.length === 0
      ? []
      : await tx
          .select({
            id: transaction.id,
            accountId: transaction.accountId,
            rawDescription: transaction.rawDescription,
            cardLast4: transaction.cardLast4,
            transferStatus: transaction.transferStatus,
            transferPairId: transaction.transferPairId,
            categoryId: transactionSplit.categoryId,
            categorySource: transactionSplit.categorySource,
            memberId: transactionSplit.memberId,
            memberSource: transactionSplit.memberSource,
          })
          .from(transaction)
          .innerJoin(transactionSplit, primarySplitJoin)
          .where(and(eq(transaction.householdId, hh), inArray(transaction.id, counterpartIds)));
  const counterparts: UndoCounterpart[] = counterpartRows.map((c) => ({
    id: c.id,
    accountId: c.accountId,
    rawDescription: c.rawDescription,
    cardLast4: c.cardLast4,
    transferStatus: c.transferStatus as TransferStatus,
    transferPairId: c.transferPairId,
    primarySplit: {
      categoryId: c.categoryId,
      categorySource: c.categorySource as CategorySource,
      memberId: c.memberId,
      memberSource: c.memberSource as MemberSource,
    },
  }));

  const { accounts, categories, cards } = await loadHouseholdConfig(ctx);
  const plan = planUndo({ batchTxs, counterparts, accounts, categories, cards });
  return {
    batch: { id: batch.id, accountId: batch.accountId, fileName: batch.fileName },
    batchTxs,
    plan,
  };
}

// R12.1：能不能撤销、弹窗要显示的笔数。只读
export async function getUndoPreview(ctx: HouseholdContext, batchId: string): Promise<UndoPreview> {
  return db.transaction(async (tx) => {
    const state = await loadUndoState(tx, ctx, batchId, false);
    if ('ok' in state) return state;
    return {
      ok: true,
      batchId: state.batch.id,
      accountId: state.batch.accountId,
      fileName: state.batch.fileName,
      deleteCount: state.batchTxs.filter((t) => !t.wasPending).length,
      prompt: state.plan.prompt,
    };
  });
}

// R12.1：一个事务里，先按 planUndo 处理配对的另一半，再恢复 pending，最后删除交易和 import_batch
// 弹窗确认在页面上做（M3-9），这里不再检查 needsConfirm
export async function undoImport(ctx: HouseholdContext, batchId: string): Promise<UndoResult> {
  return db.transaction(async (tx) => {
    const hh = ctx.householdId;
    const state = await loadUndoState(tx, ctx, batchId, true);
    if ('ok' in state) return state;
    const { batch, batchTxs, plan } = state;
    const byId = (id: string) => and(eq(transaction.id, id), eq(transaction.householdId, hh));

    // 1. 配对的另一半：先清空它指向本批次的 transfer_pair_id，外键就不用改
    for (const c of plan.counterparts) {
      if (c.action === 'unpair') {
        await tx.update(transaction).set({ transferPairId: null }).where(byId(c.id));
        continue;
      }
      await tx
        .update(transaction)
        .set({ transferPairId: null, transferStatus: c.transferStatus })
        .where(byId(c.id));
      await tx
        .update(transactionSplit)
        .set(c.primarySplit)
        .where(
          and(
            eq(transactionSplit.transactionId, c.id),
            eq(transactionSplit.householdId, hh),
            eq(transactionSplit.isPrimary, true),
          ),
        );
    }

    // 2. 被确认的 pending 恢复成 pending。日期、描述保留银行的；R8.3 例外的 transfer_status 保持 auto
    const pendingIds = batchTxs.filter((t) => t.wasPending).map((t) => t.id);
    for (const ids of chunks(pendingIds)) {
      await tx
        .update(transaction)
        .set({
          status: 'pending',
          dedupeKey: null,
          importBatchId: null,
          confirmedAt: null,
          transferPairId: null,
        })
        .where(and(eq(transaction.householdId, hh), inArray(transaction.id, ids)));
    }

    // 3. 删除本批次插入的交易（拆分级联删除），再删 import_batch
    const deleted = await tx
      .delete(transaction)
      .where(and(eq(transaction.householdId, hh), eq(transaction.importBatchId, batch.id)))
      .returning({ id: transaction.id });
    await tx
      .delete(importBatch)
      .where(and(eq(importBatch.id, batch.id), eq(importBatch.householdId, hh)));

    return {
      ok: true,
      batchId: batch.id,
      deletedCount: deleted.length,
      restoredPendingCount: pendingIds.length,
      counterparts: plan.counterparts,
    };
  });
}
