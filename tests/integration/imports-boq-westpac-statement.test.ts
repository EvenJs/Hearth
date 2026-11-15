// M9.5-9 BOQ、Westpac PDF 对账单导入（business-rules.md R1F、R1G、R4.1、R6.1、R6.2、R6.3、R6.4、R9、R12、R12.1、R12.2）
// 期望值来自 fixtures/cases/18-boq-westpac-statement.md 的 QD1 到 QD9、WD1 到 WD9、TD1 到 TD7
// fixture 的行直接交给 importStatementLines（第一层 R1F、R1G 不改，PDF buffer 那条路 R1C、R1D 已经测过）
import { and, asc, desc, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { AccountValues, AccountType } from '@/lib/accounts/account-input';
import { previewTransferRedetect, updateAccount } from '@/server/accounts';
import { getDashboard } from '@/server/dashboard';
import {
  getImportResult,
  importCsv,
  importStatementLines,
  undoImport,
  type ImportResult,
  type ImportSuccess,
} from '@/server/imports';
import {
  readAnzPlusStatementFixture,
  readBoqStatementFixture,
  readCbaStatementFixture,
  readStatementFixture,
  readWestpacStatementFixture,
  type StatementFixtureLine,
} from '../helpers/fixtures';
import {
  createTestHousehold,
  describeDb,
  resetBusinessTables,
  type DbTestHousehold,
} from './helpers/db';
import { findNumbersInDatabase } from './helpers/transactions';

let t: DbTestHousehold;

// fixtures 18 号的 4 个账户（都是 Male）
const ACCOUNTS = [
  { name: 'BOQ Everyday Male', bank: 'boq', type: 'everyday', suffix: '0007', statementName: 'Everyday Account' },
  { name: 'BOQ Future Saver Male', bank: 'boq', type: 'savings', suffix: '0008', statementName: 'Future Saver' },
  { name: 'Westpac Choice Male', bank: 'westpac', type: 'everyday', suffix: '005', statementName: 'Westpac Choice' },
  { name: 'Westpac Life Male', bank: 'westpac', type: 'savings', suffix: '006', statementName: 'Westpac Life' },
] as const;
type AccountName = (typeof ACCOUNTS)[number]['name'];

const EVERYDAY = 'BOQ Everyday Male';
const SAVER = 'BOQ Future Saver Male';
const CHOICE = 'Westpac Choice Male';
const LIFE = 'Westpac Life Male';

let ids: Map<string, string>;
// 18 号的账户和测试里另建的用 ids，fixtures 家庭的账户用 t.h
const idOf = (name: AccountName | string) => ids.get(name) ?? t.h.account(name).id;

async function insertAccount(a: {
  name: string;
  bank: 'boq' | 'westpac';
  type: AccountType;
  suffix: string;
  statementName: string | null;
}) {
  const [row] = await db
    .insert(schema.financialAccount)
    .values({
      householdId: t.ctx.householdId,
      name: a.name,
      bank: a.bank,
      type: a.type,
      defaultMemberId: t.h.member('Male').id,
      numberSuffix: a.suffix,
      statementName: a.statementName,
    })
    .returning({ id: schema.financialAccount.id });
  ids.set(a.name, row.id);
  return row.id;
}

function expectOk(result: ImportResult): ImportSuccess {
  if (!result.ok) throw new Error(`导入失败: ${result.message}`);
  return result;
}

const boq = (name: `${string}.txt`) => readBoqStatementFixture(name);
const westpac = (name: `${string}.txt`) => readWestpacStatementFixture(name);

// 不选账户（R1F、R1G 自动认账户）
const importUnassigned = (fileName: string, lines: StatementFixtureLine[]) =>
  importStatementLines(t.ctx, { fileName, lines });

const importTo = async (account: string, fileName: string, lines: StatementFixtureLine[]) =>
  expectOk(await importStatementLines(t.ctx, { accountId: idOf(account), fileName, lines }));

async function batchRow(id: string) {
  const [row] = await db.select().from(schema.importBatch).where(eq(schema.importBatch.id, id));
  return row;
}

async function countRows() {
  return { batches: await db.$count(schema.importBatch), txs: await db.$count(schema.transaction) };
}

// 某个账户的交易 + 主拆分，旧的在前
async function txsOf(account: string) {
  return db
    .select({
      id: schema.transaction.id,
      date: schema.transaction.date,
      amountCents: schema.transaction.amountCents,
      rawDescription: schema.transaction.rawDescription,
      balanceCents: schema.transaction.balanceCents,
      transferStatus: schema.transaction.transferStatus,
      transferPairId: schema.transaction.transferPairId,
      categoryId: schema.transactionSplit.categoryId,
      categorySource: schema.transactionSplit.categorySource,
      memberId: schema.transactionSplit.memberId,
      memberSource: schema.transactionSplit.memberSource,
    })
    .from(schema.transaction)
    .innerJoin(
      schema.transactionSplit,
      and(
        eq(schema.transactionSplit.transactionId, schema.transaction.id),
        eq(schema.transactionSplit.isPrimary, true),
      ),
    )
    .where(
      and(
        eq(schema.transaction.householdId, t.ctx.householdId),
        eq(schema.transaction.accountId, idOf(account)),
      ),
    )
    .orderBy(asc(schema.transaction.date), desc(schema.transaction.balanceCents));
}

const byDescription = async (account: string, prefix: string) =>
  (await txsOf(account)).filter((r) => r.rawDescription.startsWith(prefix));

// R6.1 认成内部转账的样子
function expectInternal(rows: Awaited<ReturnType<typeof txsOf>>, count: number) {
  expect(rows).toHaveLength(count);
  for (const r of rows) {
    expect(r).toMatchObject({
      transferStatus: 'auto',
      categoryId: t.h.systemCategory('internal_transfer').id,
      categorySource: 'system',
      memberId: t.h.member('Male').id,
    });
  }
}

// 配上了的 [日期, 金额]，按日期、金额绝对值从小到大
const pairedIn = (rows: Awaited<ReturnType<typeof txsOf>>) =>
  rows
    .filter((r) => r.transferPairId !== null)
    .sort((x, y) => x.date.localeCompare(y.date) || Math.abs(x.amountCents) - Math.abs(y.amountCents))
    .map((r) => [r.date, r.amountCents]);

async function novemberTotals() {
  const d = await getDashboard(
    t.ctx,
    { period: { start: '2026-11-01', end: '2026-11-30' } },
    '2026-12-01',
  );
  const { incomeCents, preTaxIncomeCents, expenseCents, uncategorized } = d.current;
  return { incomeCents, preTaxIncomeCents, expenseCents, uncategorized };
}

describeDb('M9.5-9 BOQ、Westpac importStatement', () => {
  beforeEach(async () => {
    await resetBusinessTables();
    t = await createTestHousehold();
    ids = new Map();
    for (const a of ACCOUNTS) await insertAccount(a);
  });

  // ---------- BOQ（R1F） ----------

  it('QD1: no account given → BOQ Everyday Male, 10 rows, closed period, reconciled, member Male', async () => {
    const result = expectOk(await importUnassigned('everyday-2026-11.txt', boq('everyday-2026-11.txt')));
    expect(result).toMatchObject({ rowCount: 10, insertedCount: 10, duplicateCount: 0 });
    expect(await batchRow(result.batchId)).toMatchObject({
      accountId: idOf(EVERYDAY),
      source: 'pdf',
      dateFrom: '2026-11-01',
      dateTo: '2026-11-30',
      openingBalanceCents: 0,
      closingBalanceCents: 198750,
      reconciled: true,
    });
    const rows = await txsOf(EVERYDAY);
    expect(rows).toHaveLength(10);
    // 第 3 笔余额没印，存算出来的 0
    expect(rows.find((r) => r.date === '2026-11-03' && r.amountCents === -60000)?.balanceCents).toBe(0);
    // R5：Card 1234 不进卡号映射，都是账户默认 Male
    expect(rows.every((r) => r.memberId === t.h.member('Male').id)).toBe(true);
    expect(await findNumbersInDatabase(['100000007', '129999'])).toEqual([]);
  });

  it('QD2: same statement again → 0 new, 10 skipped', async () => {
    await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    const again = await importTo(EVERYDAY, 'again.txt', boq('everyday-2026-11.txt'));
    expect(again).toMatchObject({ insertedCount: 0, duplicateCount: 10 });
  });

  it('QD3: third row printed as 0.00 → same keys, 0 new', async () => {
    await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    // Q4：第 3 笔第一行末尾补上 0.00
    const lines = boq('everyday-2026-11.txt').map((l) =>
      /To: Future Saver\s+-600\.00$/.test(l.text) ? { ...l, text: `${l.text}  0.00` } : l,
    );
    expect(lines.some((l) => l.text.endsWith('-600.00  0.00'))).toBe(true);
    const again = await importTo(EVERYDAY, 'printed-zero.txt', lines);
    expect(again).toMatchObject({ insertedCount: 0, duplicateCount: 10 });
  });

  it('QD4: on-demand, then the monthly statement → 9 skipped, 1 new, overlap noted, no continuity', async () => {
    const onDemand = await importTo(EVERYDAY, 'on-demand.txt', boq('on-demand.txt'));
    expect(onDemand).toMatchObject({ insertedCount: 9 });
    expect(await batchRow(onDemand.batchId)).toMatchObject({
      dateFrom: '2026-11-03',
      dateTo: '2026-11-06',
    });

    const monthly = await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    expect(monthly).toMatchObject({ insertedCount: 1, duplicateCount: 9 });
    expect(monthly.reconciliation.status).toBe('passed');
    expect(monthly.warnings.statementContinuity).toBeNull();
    expect(monthly.warnings.statementOverlaps).toEqual([
      { batchId: onDemand.batchId, dateFrom: '2026-11-03', dateTo: '2026-11-06' },
    ]);
    expect((await getImportResult(t.ctx, monthly.batchId))?.statementOverlaps).toEqual([
      { batchId: onDemand.batchId, dateFrom: '2026-11-03', dateTo: '2026-11-06' },
    ]);
  });

  it('QD5: November then empty December → batch created, connected, no overlap', async () => {
    const nov = await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    const dec = await importTo(EVERYDAY, 'empty-2026-12.txt', boq('empty-2026-12.txt'));
    expect(dec).toMatchObject({ insertedCount: 0 });
    expect(await batchRow(dec.batchId)).toMatchObject({ dateFrom: '2026-12-01', reconciled: true });
    expect(dec.warnings.statementContinuity).toEqual({
      status: 'connected',
      previous: { batchId: nov.batchId, dateFrom: '2026-11-01', dateTo: '2026-11-30' },
    });
    expect(dec.warnings).not.toHaveProperty('statementOverlaps');
  });

  it('QD6: no account given → BOQ Future Saver Male, 7 new', async () => {
    const result = expectOk(await importUnassigned('saver-2026-11.txt', boq('saver-2026-11.txt')));
    expect(result.insertedCount).toBe(7);
    expect((await batchRow(result.batchId)).accountId).toBe(idOf(SAVER));
  });

  it('QD7: wrong-account.txt → no BOQ account with 0002, nothing written', async () => {
    expect(await importUnassigned('wrong-account.txt', boq('wrong-account.txt'))).toMatchObject({
      ok: false,
      message: '找不到尾号是 0002 的 BOQ 账户，先去账户设置填上尾号',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('QD8: another BOQ account with suffix 00007 → two match, nothing written', async () => {
    await insertAccount({ name: 'BOQ Other', bank: 'boq', type: 'everyday', suffix: '00007', statementName: null });
    expect(
      await importUnassigned('everyday-2026-11.txt', boq('everyday-2026-11.txt')),
    ).toMatchObject({
      ok: false,
      message: '有 2 个 BOQ 账户的尾号都对得上，去账户设置把尾号填长一点',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('QD9 / WD9: ANZ, ANZ Plus, CBA and Westpac statements still find their own accounts', async () => {
    const cases: [string, StatementFixtureLine[], string][] = [
      ['joint-2026-09.txt', readStatementFixture('joint-2026-09.txt'), 'ANZ Joint'],
      ['growth-2026-09.txt', readAnzPlusStatementFixture('growth-2026-09.txt'), 'ANZ Plus Male'],
      ['female-2026-09.txt', readCbaStatementFixture('female-2026-09.txt'), 'CBA Female'],
      ['choice-2026-11.txt', westpac('choice-2026-11.txt'), CHOICE],
    ];
    for (const [fileName, lines, account] of cases) {
      const result = expectOk(await importUnassigned(fileName, lines));
      expect((await batchRow(result.batchId)).accountId, fileName).toBe(idOf(account));
    }
  });

  // ---------- Westpac（R1G） ----------

  it('WD1: no account given → Westpac Choice Male, 5 rows, reconciled, no full account number stored', async () => {
    const result = expectOk(await importUnassigned('choice-2026-11.txt', westpac('choice-2026-11.txt')));
    expect(result).toMatchObject({ insertedCount: 5 });
    expect(await batchRow(result.batchId)).toMatchObject({
      accountId: idOf(CHOICE),
      source: 'pdf',
      dateFrom: '2026-11-01',
      dateTo: '2026-11-30',
      openingBalanceCents: 100000,
      closingBalanceCents: 246355,
      reconciled: true,
    });
    expect((await txsOf(CHOICE)).every((r) => r.memberId === t.h.member('Male').id)).toBe(true);
    expect(await findNumbersInDatabase(['120005', '039999'])).toEqual([]);
  });

  it('WD2: same statement again → 0 new, 5 skipped', async () => {
    await importTo(CHOICE, 'choice-2026-11.txt', westpac('choice-2026-11.txt'));
    expect(await importTo(CHOICE, 'again.txt', westpac('choice-2026-11.txt'))).toMatchObject({
      insertedCount: 0,
      duplicateCount: 5,
    });
  });

  it('WD3: one-day, then the monthly statement → 2 skipped, 3 new, overlap noted, no continuity', async () => {
    const oneDay = await importTo(CHOICE, 'one-day.txt', westpac('one-day.txt'));
    expect(oneDay.insertedCount).toBe(2);
    expect(await batchRow(oneDay.batchId)).toMatchObject({
      dateFrom: '2026-11-03',
      dateTo: '2026-11-03',
      reconciled: true,
    });

    const monthly = await importTo(CHOICE, 'choice-2026-11.txt', westpac('choice-2026-11.txt'));
    expect(monthly).toMatchObject({ insertedCount: 3, duplicateCount: 2 });
    expect(monthly.reconciliation.status).toBe('passed');
    expect(monthly.warnings.statementContinuity).toBeNull();
    expect(monthly.warnings.statementOverlaps).toEqual([
      { batchId: oneDay.batchId, dateFrom: '2026-11-03', dateTo: '2026-11-03' },
    ]);
  });

  it('WD4: November then empty December → connected, no overlap', async () => {
    const nov = await importTo(CHOICE, 'choice-2026-11.txt', westpac('choice-2026-11.txt'));
    const dec = await importTo(CHOICE, 'empty-2026-12.txt', westpac('empty-2026-12.txt'));
    expect(dec).toMatchObject({ insertedCount: 0 });
    expect(await batchRow(dec.batchId)).toMatchObject({ dateFrom: '2026-12-01', reconciled: true });
    expect(dec.warnings.statementContinuity).toMatchObject({
      status: 'connected',
      previous: { batchId: nov.batchId },
    });
    expect(dec.warnings).not.toHaveProperty('statementOverlaps');
  });

  it('WD5: November, then the one-day statement → 2 skipped, overlap with November, no continuity', async () => {
    const nov = await importTo(CHOICE, 'choice-2026-11.txt', westpac('choice-2026-11.txt'));
    const oneDay = await importTo(CHOICE, 'one-day.txt', westpac('one-day.txt'));
    expect(oneDay).toMatchObject({ insertedCount: 0, duplicateCount: 2 });
    expect(oneDay.warnings.statementContinuity).toBeNull();
    expect(oneDay.warnings.statementOverlaps).toEqual([
      { batchId: nov.batchId, dateFrom: '2026-11-01', dateTo: '2026-11-30' },
    ]);
  });

  it('WD6: wrong-account.txt → no Westpac account with 0002 (ANZ Male does not count)', async () => {
    expect(await importUnassigned('wrong-account.txt', westpac('wrong-account.txt'))).toMatchObject({
      ok: false,
      message: '找不到尾号是 0002 的 Westpac 账户，先去账户设置填上尾号',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('WD7: another Westpac account with suffix 0005 → two match, nothing written', async () => {
    await insertAccount({ name: 'Westpac Other', bank: 'westpac', type: 'everyday', suffix: '0005', statementName: null });
    expect(
      await importUnassigned('choice-2026-11.txt', westpac('choice-2026-11.txt')),
    ).toMatchObject({
      ok: false,
      message: '有 2 个 Westpac 账户的尾号都对得上，去账户设置把尾号填长一点',
    });
    expect(await countRows()).toEqual({ batches: 0, txs: 0 });
  });

  it('WD8: no account given → Westpac Life Male (not Choice), 3 new', async () => {
    const result = expectOk(await importUnassigned('life-2026-11.txt', westpac('life-2026-11.txt')));
    expect(result.insertedCount).toBe(3);
    expect((await batchRow(result.batchId)).accountId).toBe(idOf(LIFE));
  });

  it('R1: BOQ and Westpac cannot import CSV', async () => {
    for (const name of [EVERYDAY, CHOICE]) {
      expect(
        await importCsv(t.ctx, { accountId: idOf(name), fileName: 'a.csv', text: '01/11/2026,"1.00",X' }),
      ).toMatchObject({ ok: false, reason: 'not_importable' });
    }
  });

  // ---------- 同行内部转账（R6.1 按账户名认） ----------

  it('TD1: Everyday then Saver → 7 + 7 auto; 400 and 600 pair, the five 100s do not; dashboard unchanged', async () => {
    await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    const afterEveryday = await novemberTotals();
    await importTo(SAVER, 'saver-2026-11.txt', boq('saver-2026-11.txt'));

    const out = await byDescription(EVERYDAY, 'To: Future Saver');
    const into = await byDescription(SAVER, 'From: Everyday Account');
    expectInternal(out, 7);
    expectInternal(into, 7);
    expect(pairedIn(out)).toEqual([
      ['2026-11-03', -40000],
      ['2026-11-03', -60000],
    ]);
    expect(pairedIn(into)).toEqual([
      ['2026-11-03', 40000],
      ['2026-11-03', 60000],
    ]);
    // From: TEST FRIEND、From: ACME PTY LTD 不是转账
    for (const prefix of ['From: TEST FRIEND', 'From: ACME PTY LTD']) {
      expect((await byDescription(EVERYDAY, prefix))[0].transferStatus).toBe('none');
    }
    // 不计收支：Saver 那 7 笔转入不改变看板
    expect(await novemberTotals()).toEqual(afterEveryday);
  });

  it('TD2: Saver then Everyday → same as TD1', async () => {
    await importTo(SAVER, 'saver-2026-11.txt', boq('saver-2026-11.txt'));
    await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    const out = await byDescription(EVERYDAY, 'To: Future Saver');
    const into = await byDescription(SAVER, 'From: Everyday Account');
    expectInternal(out, 7);
    expectInternal(into, 7);
    expect(pairedIn(out)).toEqual([
      ['2026-11-03', -40000],
      ['2026-11-03', -60000],
    ]);
    expect(pairedIn(into)).toHaveLength(2);
  });

  it('TD3: Choice then Life → 3 + 3 auto; 1186.45 pairs, the two 300s do not; Osko not a transfer', async () => {
    await importTo(CHOICE, 'choice-2026-11.txt', westpac('choice-2026-11.txt'));
    await importTo(LIFE, 'life-2026-11.txt', westpac('life-2026-11.txt'));
    const out = await byDescription(CHOICE, 'Withdrawal Mobile');
    const into = await byDescription(LIFE, 'Deposit Online');
    expectInternal(out, 3);
    expectInternal(into, 3);
    expect(pairedIn(out)).toEqual([['2026-11-15', -118645]]);
    expect(pairedIn(into)).toEqual([['2026-11-15', 118645]]);
    const osko = await byDescription(CHOICE, 'Deposit-Osko');
    expect(osko.map((r) => r.transferStatus)).toEqual(['none', 'none']);
  });

  it('TD4 / TD5: Saver statement_name filled later → R6.4 N = 7; then importing Saver pairs 400 and 600', async () => {
    await db
      .update(schema.financialAccount)
      .set({ statementName: null })
      .where(eq(schema.financialAccount.id, idOf(SAVER)));
    await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    const before = await byDescription(EVERYDAY, 'To: Future Saver');
    expect(before.map((r) => r.transferStatus)).toEqual(Array(7).fill('none'));

    const values: AccountValues = {
      name: SAVER,
      bank: 'boq',
      type: 'savings',
      defaultMemberId: t.h.member('Male').id,
      numberSuffix: '0008',
      statementName: 'Future Saver',
    };
    expect(await previewTransferRedetect(t.ctx, idOf(SAVER), values)).toEqual({
      count: 7,
      keptCount: 0,
    });
    expect(await updateAccount(t.ctx, idOf(SAVER), values, { redetect: true })).toEqual({
      redetectedCount: 7,
      pairedCount: 0,
    });
    expectInternal(await byDescription(EVERYDAY, 'To: Future Saver'), 7);
    // 重复保存不会再改（N = 0）
    expect(await previewTransferRedetect(t.ctx, idOf(SAVER), values)).toEqual({
      count: 0,
      keptCount: 0,
    });

    // TD5
    await importTo(SAVER, 'saver-2026-11.txt', boq('saver-2026-11.txt'));
    const into = await byDescription(SAVER, 'From: Everyday Account');
    expectInternal(into, 7);
    expect(pairedIn(into)).toEqual([
      ['2026-11-03', 40000],
      ['2026-11-03', 60000],
    ]);
  });

  it('TD6 / TD7: another "Future Saver" account → Everyday side auto with unknown counterpart; Saver side pairs 400 and 600', async () => {
    await insertAccount({ name: 'BOQ Test', bank: 'boq', type: 'savings', suffix: '0011', statementName: 'Future Saver' });

    // TD6
    await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    const out = await byDescription(EVERYDAY, 'To: Future Saver');
    expectInternal(out, 7);
    expect(pairedIn(out)).toEqual([]);

    // TD7
    await importTo(SAVER, 'saver-2026-11.txt', boq('saver-2026-11.txt'));
    const into = await byDescription(SAVER, 'From: Everyday Account');
    expectInternal(into, 7);
    expect(pairedIn(into)).toEqual([
      ['2026-11-03', 40000],
      ['2026-11-03', 60000],
    ]);
    expect(pairedIn(await byDescription(EVERYDAY, 'To: Future Saver'))).toEqual([
      ['2026-11-03', -40000],
      ['2026-11-03', -60000],
    ]);
    expect(await txsOf('BOQ Test')).toEqual([]);
  });

  // ---------- 外行转账（R6.3） ----------

  it('R6.3: ANZ Male → BOQ Everyday by name only → suggested once both sides are imported', async () => {
    await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    // 编的一行：ANZ Male 转给 BOQ 那边的户名，没有账号（R6.1 认不出），和 From: TEST FRIEND 金额相反、同一天
    const anz = expectOk(
      await importCsv(t.ctx, {
        accountId: t.h.account('ANZ Male').id,
        fileName: 'anz-male-2026-11.csv',
        text: '03/11/2026,"-1000.00",ANZ M-BANKING PAYMENT TO TEST FRIEND\r\n',
      }),
    );
    const [friend] = await byDescription(EVERYDAY, 'From: TEST FRIEND');
    expect(anz.transfers.suggestions).toEqual([
      { aId: expect.any(String), bId: expect.any(String) },
    ]);
    expect(Object.values(anz.transfers.suggestions[0])).toContain(friend.id);
  });

  // ---------- R12.1 撤销 ----------

  it('R12.1: undo the monthly statement after on-demand → only its 1 new row is deleted', async () => {
    await importTo(EVERYDAY, 'on-demand.txt', boq('on-demand.txt'));
    const monthly = await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    expect(await undoImport(t.ctx, monthly.batchId)).toMatchObject({ ok: true, deletedCount: 1 });
    expect(await txsOf(EVERYDAY)).toHaveLength(9);
  });

  it('R12.1: undo Saver after TD1 → Everyday 400 / 600 stay auto (re-detected by name), only unpaired', async () => {
    await importTo(EVERYDAY, 'everyday-2026-11.txt', boq('everyday-2026-11.txt'));
    const saver = await importTo(SAVER, 'saver-2026-11.txt', boq('saver-2026-11.txt'));
    expect(await undoImport(t.ctx, saver.batchId)).toMatchObject({ ok: true, deletedCount: 7 });
    const out = await byDescription(EVERYDAY, 'To: Future Saver');
    expectInternal(out, 7);
    expect(pairedIn(out)).toEqual([]);
  });
});
