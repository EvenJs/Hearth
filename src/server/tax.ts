// 税务的数据层（M7-5，R14.1、R14.3、R14.6、R14.7；M14-3 加 R14.9 在职段、R14.10 预计利息）
// 计算在 src/lib/tax/estimate.ts、jobs.ts，这里负责读拆分、members、tax_profile、tax_job 和写入
// 没有税率表的财年不抛错，返回 missingRates 让页面显示提示（R14.7）
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { category, member, taxJob, taxProfile, transaction, transactionSplit } from '@/db/schema';
import { pickAnchor } from '@/lib/rules/balance';
import { dataAsOf } from '@/lib/rules/conditions';
import { parseBalanceToCents } from '@/lib/rules/money';
import type { StatSplit } from '@/lib/rules/stats';
import {
  estimateHouseholdTax,
  financialYearRange,
  type MemberTaxEstimate,
} from '@/lib/tax/estimate';
import { prorateJobs, type ProratedJob } from '@/lib/tax/jobs';
import { availableFinancialYears, financialYearLabel } from '@/lib/tax/rates';
import { loadAnchors } from './balances';
import { loadLatestConfirmed } from './conditions';
import type { HouseholdContext } from './context';
import { listMembers, type Member } from './members';
import type { DbTx } from './transactions';

// 三个金额各自为空 = 没填实际数（R14.3、R14.10）
export type TaxProfileRow = {
  paygGrossCents: number | null;
  paygWithheldCents: number | null;
  expectedInterestCents: number | null;
  updatedAt: Date;
};

// R14.9 在职段，不按财年分
export type TaxJobRow = {
  id: string;
  memberId: string;
  employer: string | null;
  annualSalaryCents: number;
  startDate: string;
  endDate: string | null; // null = 还在职
};

export type PersonTax = {
  member: Member;
  profile: TaxProfileRow | null; // null：还没填（R14.6）
  // 这个人的全部在职段和这个财年的折算数，按开始日期排；不在这个财年的 days = 0
  jobs: ProratedJob<TaxJobRow>[];
  estimate: MemberTaxEstimate;
  // R14.6：有利息的账户里最早的"数据截至"（R24.6）。只在 estimate.interestPartial 时算，其余是 null
  // interestPartial 但这些账户都没有截至日期时也是 null
  interestAsOf: string | null;
};

export type HouseholdTax =
  | { missingRates: string } // "2027-28"（R14.7）
  | {
      missingRates: null;
      financialYear: number;
      taxCategoryMissing: boolean; // Income / Tax (ATO) 被改名或删了，已预缴按 0 算
      persons: PersonTax[]; // 按 members 的 sort_order
    };

export type TaxWriteResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'not_found'; message: string };

// ---------- 查询 ----------

// Tax (ATO)、Interest 不是系统分类：按名字找一级 Income 下的二级分类，不区分大小写
// 含已归档的，老拆分可能还指着它。找不到是 null
async function findIncomeCategoryIds(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
): Promise<{ taxId: string | null; interestId: string | null }> {
  const rows = await tx
    .select({ id: category.id, parentId: category.parentId, nameEn: category.nameEn })
    .from(category)
    .where(eq(category.householdId, ctx.householdId));
  const is = (name: string, expected: string) => name.trim().toLowerCase() === expected;
  const incomeIds = new Set(
    rows.filter((c) => c.parentId === null && is(c.nameEn, 'income')).map((c) => c.id),
  );
  const find = (name: string) =>
    rows.find((c) => c.parentId !== null && incomeIds.has(c.parentId) && is(c.nameEn, name))
      ?.id ?? null;
  return { taxId: find('tax (ato)'), interestId: find('interest') };
}

// accountId 只用来找 R14.6 有利息的账户
type YearSplit = StatSplit & { accountId: string };

// 这个财年内的拆分，pending 也算（R10）
async function loadYearSplits(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
  financialYear: number,
): Promise<YearSplit[]> {
  const { start, end } = financialYearRange(financialYear);
  return tx
    .select({
      accountId: transaction.accountId,
      date: transaction.date,
      amountCents: transactionSplit.amountCents,
      categoryId: transactionSplit.categoryId,
      memberId: transactionSplit.memberId,
      isPreTax: transactionSplit.isPreTax,
    })
    .from(transactionSplit)
    .innerJoin(
      transaction,
      and(
        eq(transaction.id, transactionSplit.transactionId),
        eq(transaction.householdId, ctx.householdId),
      ),
    )
    .where(
      and(
        eq(transactionSplit.householdId, ctx.householdId),
        gte(transaction.date, start),
        lte(transaction.date, end),
      ),
    );
}

async function loadProfiles(tx: DbTx | typeof db, ctx: HouseholdContext, financialYear: number) {
  return tx
    .select({
      memberId: taxProfile.memberId,
      paygGrossCents: taxProfile.paygGrossCents,
      paygWithheldCents: taxProfile.paygWithheldCents,
      expectedInterestCents: taxProfile.expectedInterestCents,
      updatedAt: taxProfile.updatedAt,
    })
    .from(taxProfile)
    .where(
      and(eq(taxProfile.householdId, ctx.householdId), eq(taxProfile.financialYear, financialYear)),
    );
}

const jobColumns = {
  id: taxJob.id,
  memberId: taxJob.memberId,
  employer: taxJob.employer,
  annualSalaryCents: taxJob.annualSalaryCents,
  startDate: taxJob.startDate,
  endDate: taxJob.endDate,
};

// R14.9：本家庭的全部在职段，不按财年筛，折算在 jobs.ts 里按天数算
export async function listTaxJobs(
  ctx: HouseholdContext,
  tx: DbTx | typeof db = db,
): Promise<TaxJobRow[]> {
  return tx
    .select(jobColumns)
    .from(taxJob)
    .where(eq(taxJob.householdId, ctx.householdId))
    .orderBy(asc(taxJob.startDate), asc(taxJob.createdAt));
}

// R24.6：每个账户的"数据截至" = max(锚点日期, 最晚一笔 confirmed)。都没有 → 不在 map 里
async function loadAccountsAsOf(
  ctx: HouseholdContext,
  accountIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (accountIds.length === 0) return result;
  const [anchors, latest] = await Promise.all([
    loadAnchors(db, ctx, accountIds),
    loadLatestConfirmed(ctx, accountIds),
  ]);
  for (const id of accountIds) {
    const latestDate = latest.get(id);
    const asOf = dataAsOf(
      pickAnchor(anchors.get(id) ?? [])?.date ?? null,
      latestDate ? [{ date: latestDate, status: 'confirmed' }] : [],
    );
    if (asOf !== null) result.set(id, asOf);
  }
  return result;
}

// R14.3、R14.6：每个 person 的估算。设置页和看板（M7-6）共用
export async function getHouseholdTax(
  ctx: HouseholdContext,
  financialYear: number,
): Promise<HouseholdTax> {
  // R14.7：没有税率表时不抛错
  if (!availableFinancialYears().includes(financialYear)) {
    return { missingRates: financialYearLabel(financialYear) };
  }

  const [members, data] = await Promise.all([
    listMembers(ctx),
    db.transaction(
      async (tx) =>
        Promise.all([
          loadYearSplits(tx, ctx, financialYear),
          loadProfiles(tx, ctx, financialYear),
          listTaxJobs(ctx, tx),
          findIncomeCategoryIds(tx, ctx),
        ]),
      { accessMode: 'read only' },
    ),
  ]);
  const [splits, profiles, jobs, categoryIds] = data;
  const taxCategoryId = categoryIds.taxId;

  const estimates = estimateHouseholdTax({
    splits,
    members,
    profiles: profiles.map((p) => ({ ...p, financialYear })),
    jobs,
    // 找不到 Tax (ATO) 时传空 id，不会匹配任何拆分，已预缴就是 0
    taxCategoryId: taxCategoryId ?? '',
    // 找不到 Interest 时已到账利息是 0，利息部分只看预计（R14.10）
    interestCategoryId: categoryIds.interestId ?? '',
    financialYear,
  });

  // R14.6：有利息的账户 = 这个财年里有 Income / Interest 拆分、归属人是这个人或 shared 的交易所在账户
  // 只给 interestPartial 的人找；找不到 Interest 分类时已到账是 0，不会 partial
  const sharedIds = new Set(members.filter((m) => m.kind === 'shared').map((m) => m.id));
  const interestAccounts = new Map<string, Set<string>>();
  for (const e of estimates) {
    if (!e.interestPartial) continue;
    const ids = splits
      .filter(
        (s) =>
          s.categoryId === categoryIds.interestId &&
          (s.memberId === e.memberId || sharedIds.has(s.memberId)),
      )
      .map((s) => s.accountId);
    interestAccounts.set(e.memberId, new Set(ids));
  }
  const accountAsOf = await loadAccountsAsOf(ctx, [
    ...new Set([...interestAccounts.values()].flatMap((s) => [...s])),
  ]);
  // 取最早的；没有截至日期的账户跳过
  const interestAsOf = (memberId: string): string | null => {
    let earliest: string | null = null;
    for (const id of interestAccounts.get(memberId) ?? []) {
      const asOf = accountAsOf.get(id);
      if (asOf !== undefined && (earliest === null || asOf < earliest)) earliest = asOf;
    }
    return earliest;
  };

  const byId = new Map(members.map((m) => [m.id, m]));
  const persons = estimates.map((estimate): PersonTax => {
    const p = profiles.find((r) => r.memberId === estimate.memberId);
    return {
      member: byId.get(estimate.memberId)!,
      profile: p
        ? {
            paygGrossCents: p.paygGrossCents,
            paygWithheldCents: p.paygWithheldCents,
            expectedInterestCents: p.expectedInterestCents,
            updatedAt: p.updatedAt,
          }
        : null,
      jobs: prorateJobs(
        jobs.filter((j) => j.memberId === estimate.memberId),
        financialYear,
      ).jobs,
      estimate,
      interestAsOf: interestAsOf(estimate.memberId),
    };
  });

  return { missingRates: null, financialYear, taxCategoryMissing: taxCategoryId === null, persons };
}

// ---------- 写入 ----------

const amountSchema = z.string().max(100);

// 元，"60000.00"；空串 = 没填实际数，存 null（R14.3、R14.10）
const saveSchema = z.object({
  memberId: z.uuid(),
  financialYear: z.number().int(),
  paygGross: amountSchema,
  paygWithheld: amountSchema,
  expectedInterest: amountSchema.default(''),
});

export type SaveTaxProfileInput = z.input<typeof saveSchema>;

const INVALID = { ok: false, reason: 'invalid', message: '输入不对' } as const;
const MEMBER_NOT_FOUND = { ok: false, reason: 'not_found', message: '归属人不存在' } as const;

// 元 → 分，可以是 0，不能是负数。格式不对返回 null
// parseAmountToCents 不接受 0；parseBalanceToCents 是同一套格式，只是允许 0
function parseDollars(input: string): number | null {
  try {
    const cents = parseBalanceToCents(input);
    return cents >= 0 ? cents : null;
  } catch {
    return null;
  }
}

// 留空 → { cents: null }；格式不对 → null
function parseOptionalDollars(input: string): { cents: number | null } | null {
  if (input.trim() === '') return { cents: null };
  const cents = parseDollars(input);
  return cents === null ? null : { cents };
}

// 只能是本家庭、没归档、kind = person 的 member
async function isPersonMember(ctx: HouseholdContext, memberId: string): Promise<boolean> {
  const [m] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.id, memberId),
        eq(member.householdId, ctx.householdId),
        eq(member.isArchived, false),
        eq(member.kind, 'person'),
      ),
    );
  return m !== undefined;
}

// upsert (member_id, financial_year)。填 0 也照样保存：等于"填过了，没有工资"
// 三格都留空也存一行全是 null 的：估算和没填一样，卡片上有"清除"按钮
export async function saveTaxProfile(
  ctx: HouseholdContext,
  input: SaveTaxProfileInput,
): Promise<TaxWriteResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const { memberId, financialYear } = parsed.data;

  // R14.7：只能保存有税率表的财年
  if (!availableFinancialYears().includes(financialYear)) {
    return {
      ok: false,
      reason: 'invalid',
      message: `没有 ${financialYearLabel(financialYear)} 财年的税率表，不能保存`,
    };
  }

  const gross = parseOptionalDollars(parsed.data.paygGross);
  const withheld = parseOptionalDollars(parsed.data.paygWithheld);
  const interest = parseOptionalDollars(parsed.data.expectedInterest);
  if (gross === null || withheld === null || interest === null) {
    return { ok: false, reason: 'invalid', message: '金额要是 0 或正数，最多两位小数' };
  }
  const paygGrossCents = gross.cents;
  const paygWithheldCents = withheld.cents;
  const expectedInterestCents = interest.cents;
  // 两个都是实际数时才比；有一个用折算就不比
  if (paygGrossCents !== null && paygWithheldCents !== null && paygWithheldCents > paygGrossCents) {
    return { ok: false, reason: 'invalid', message: '已代扣的税不能超过税前总额' };
  }

  if (!(await isPersonMember(ctx, memberId))) return MEMBER_NOT_FOUND;

  await db
    .insert(taxProfile)
    .values({
      householdId: ctx.householdId,
      memberId,
      financialYear,
      paygGrossCents,
      paygWithheldCents,
      expectedInterestCents,
    })
    .onConflictDoUpdate({
      target: [taxProfile.memberId, taxProfile.financialYear],
      // $onUpdate 只在 update() 里生效，upsert 要自己写 updated_at
      set: { paygGrossCents, paygWithheldCents, expectedInterestCents, updatedAt: new Date() },
    });
  return { ok: true };
}

const deleteSchema = z.object({
  memberId: z.uuid(),
  financialYear: z.number().int(),
});

export type DeleteTaxProfileInput = z.input<typeof deleteSchema>;

// R14.8：删掉这一行 = 回到"还没填"（不是改成 0），三个金额一起清，在职段不动。只删本家庭的
// 记录已经不在（另一个人刚清了）也算成功；不检查税率表
export async function deleteTaxProfile(
  ctx: HouseholdContext,
  input: DeleteTaxProfileInput,
): Promise<TaxWriteResult> {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const { memberId, financialYear } = parsed.data;

  await db
    .delete(taxProfile)
    .where(
      and(
        eq(taxProfile.householdId, ctx.householdId),
        eq(taxProfile.memberId, memberId),
        eq(taxProfile.financialYear, financialYear),
      ),
    );
  return { ok: true };
}

// ---------- 在职段（R14.9） ----------

// 年薪是元，"120000.00"；结束日期空串 = 还在职；雇主空串存 null
const jobFieldsSchema = z.object({
  employer: z.string().trim().max(100),
  annualSalary: amountSchema,
  startDate: z.iso.date(),
  endDate: z.union([z.iso.date(), z.literal('')]),
});

const createJobSchema = jobFieldsSchema.extend({ memberId: z.uuid() });
const updateJobSchema = jobFieldsSchema.extend({ id: z.uuid() });

export type CreateTaxJobInput = z.input<typeof createJobSchema>;
export type UpdateTaxJobInput = z.input<typeof updateJobSchema>;

const JOB_NOT_FOUND = { ok: false, reason: 'not_found', message: '这份工作不存在' } as const;

// R14.9 保存时检查：年薪 > 0；结束不能早于开始，开始等于结束 = 1 天可以
// 不检查税率表：在职段不属于某个财年，没有表的财年在估算时才报（R14.7）
function parseJobFields(
  input: z.infer<typeof jobFieldsSchema>,
):
  | { ok: true; values: Omit<TaxJobRow, 'id' | 'memberId'> }
  | { ok: false; reason: 'invalid'; message: string } {
  const annualSalaryCents = parseDollars(input.annualSalary);
  if (annualSalaryCents === null || annualSalaryCents === 0) {
    return { ok: false, reason: 'invalid', message: '年薪要大于 0，最多两位小数' };
  }
  const endDate = input.endDate === '' ? null : input.endDate;
  if (endDate !== null && endDate < input.startDate) {
    return { ok: false, reason: 'invalid', message: '结束日期不能早于开始日期' };
  }
  return {
    ok: true,
    values: {
      employer: input.employer === '' ? null : input.employer,
      annualSalaryCents,
      startDate: input.startDate,
      endDate,
    },
  };
}

export async function createTaxJob(
  ctx: HouseholdContext,
  input: CreateTaxJobInput,
): Promise<TaxWriteResult> {
  const parsed = createJobSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const fields = parseJobFields(parsed.data);
  if (!fields.ok) return fields;

  if (!(await isPersonMember(ctx, parsed.data.memberId))) return MEMBER_NOT_FOUND;

  await db
    .insert(taxJob)
    .values({ householdId: ctx.householdId, memberId: parsed.data.memberId, ...fields.values });
  return { ok: true };
}

// 归属人不能改：换人就删了重建
export async function updateTaxJob(
  ctx: HouseholdContext,
  input: UpdateTaxJobInput,
): Promise<TaxWriteResult> {
  const parsed = updateJobSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const fields = parseJobFields(parsed.data);
  if (!fields.ok) return fields;

  const updated = await db
    .update(taxJob)
    .set(fields.values)
    .where(and(eq(taxJob.id, parsed.data.id), eq(taxJob.householdId, ctx.householdId)))
    .returning({ id: taxJob.id });
  return updated.length > 0 ? { ok: true } : JOB_NOT_FOUND;
}

const deleteJobSchema = z.object({ id: z.uuid() });

export type DeleteTaxJobInput = z.input<typeof deleteJobSchema>;

// R14.9：确认在页面上做。已经不在（另一个人刚删了）也算成功，和 R14.8 一样
export async function deleteTaxJob(
  ctx: HouseholdContext,
  input: DeleteTaxJobInput,
): Promise<TaxWriteResult> {
  const parsed = deleteJobSchema.safeParse(input);
  if (!parsed.success) return INVALID;

  await db
    .delete(taxJob)
    .where(and(eq(taxJob.id, parsed.data.id), eq(taxJob.householdId, ctx.householdId)));
  return { ok: true };
}
