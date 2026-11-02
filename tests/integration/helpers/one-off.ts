// M7.7 集成测试 helper：按 fixtures/cases/12-monthly-average.md 直接插交易和拆分
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { OneOffFlag } from '@/lib/rules/one-off';
import type { DbTestHousehold } from './db';

export type SplitRow = [
  amountCents: number,
  category: string,
  isOneOff: OneOffFlag,
  member?: string,
];

export const FURNITURE = 'Home & utilities / Furniture & appliances';
export const SUPERMARKET = 'Groceries / Supermarket';

// 用例的 # 写在 merchant 上，方便按名字找。拆分第一个是主拆分
export async function insertTx(
  t: DbTestHousehold,
  name: string,
  date: string,
  splits: SplitRow[],
  status: 'confirmed' | 'pending' = 'confirmed',
): Promise<string> {
  const { ctx, h } = t;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.transaction)
      .values({
        householdId: ctx.householdId,
        accountId: h.account('ANZ Joint').id,
        date,
        amountCents: splits.reduce((s, [a]) => s + a, 0),
        rawDescription: name,
        merchant: name,
        status,
        source: 'manual',
        createdBy: ctx.userId,
      })
      .returning({ id: schema.transaction.id });
    await tx.insert(schema.transactionSplit).values(
      splits.map(([amountCents, category, isOneOff, memberName], i) => ({
        householdId: ctx.householdId,
        transactionId: row.id,
        amountCents,
        categoryId: h.category(category).id,
        memberId: h.member(memberName ?? 'Home').id,
        categorySource: 'manual',
        memberSource: 'manual',
        isPrimary: i === 0,
        isPreTax: false,
        isOneOff,
      })),
    );
    return row.id;
  });
}

// ---------- 场景 A（今天 = 2026-11-15） ----------

export const SCENARIO_A: [string, string, SplitRow][] = [
  ['#1', '2026-06-10', [300000, 'Income / Salary', null, 'Female']],
  ['#2', '2026-06-12', [-200000, 'Home & utilities / Rent', false]],
  ['#3', '2026-06-20', [-9998, SUPERMARKET, null]],
  ['#4', '2026-07-01', [-200000, 'Home & utilities / Rent', false]],
  ['#5', '2026-07-15', [-12000, SUPERMARKET, null]],
  ['#6', '2026-07-20', [-150000, FURNITURE, true]],
  ['#7', '2026-08-01', [-200000, 'Home & utilities / Rent', false]],
  ['#8', '2026-08-09', [-9500, SUPERMARKET, null]],
  ['#9', '2026-08-09', [-1303, 'Groceries / Fruit', null]],
  ['#10', '2026-08-25', [30000, FURNITURE, true]],
  ['#11', '2026-09-01', [-200000, 'Home & utilities / Rent', false]],
  ['#12', '2026-09-14', [-11000, SUPERMARKET, null]],
  ['#13', '2026-09-18', [4580, 'Personal & medical / Other', null, 'Female']],
  ['#14', '2026-09-20', [-900, 'Entertainment & eat-out / Bubble tea', null, 'Male']],
  ['#15', '2026-09-28', [-120000, 'Entertainment & eat-out / Holidays', true]],
  ['#16', '2026-10-01', [-200000, 'Home & utilities / Rent', false]],
  ['#17', '2026-10-05', [-13000, SUPERMARKET, null]],
  ['#18', '2026-10-06', [500, SUPERMARKET, null]],
  ['#19', '2026-10-12', [-653, 'Entertainment & eat-out / Bubble tea', null, 'Male']],
  ['#20', '2026-10-15', [-6001, 'Personal & medical / Clothing & shoes', null, 'Female']],
  ['#21', '2026-10-22', [-50000, 'Internal transfer', null]],
  ['#22', '2026-10-23', [-2000, 'Uncategorised', null]],
  ['#23', '2026-10-30', [-5002, 'Cash withdrawal', null]],
  ['#24', '2026-11-03', [-14000, SUPERMARKET, null]],
  ['#25', '2026-11-08', [-80000, FURNITURE, true]],
  ['#26', '2026-11-10', [-450, 'Entertainment & eat-out / Bubble tea', null, 'Male']],
  ['#27', '2026-11-12', [-3000, 'Transport & auto / Petrol / EV charging', null]],
];

// 一笔交易一个拆分，#20 是 pending。返回 # → 交易 id
export async function insertScenarioA(t: DbTestHousehold): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const [name, date, split] of SCENARIO_A) {
    ids.set(name, await insertTx(t, name, date, [split], name === '#20' ? 'pending' : 'confirmed'));
  }
  return ids;
}
