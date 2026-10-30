// 税务的数据层（M7-5，R14.1、R14.3、R14.6、R14.7）
// 计算在 src/lib/tax/estimate.ts，这里负责读拆分、members、tax_profile 和写 tax_profile
// 没有税率表的财年不抛错，返回 missingRates 让页面显示提示（R14.7）
import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { category, member, taxProfile, transaction, transactionSplit } from '@/db/schema';
import { parseBalanceToCents } from '@/lib/rules/money';
import type { StatSplit } from '@/lib/rules/stats';
import {
  estimateHouseholdTax,
  financialYearRange,
  type MemberTaxEstimate,
} from '@/lib/tax/estimate';
import { availableFinancialYears, financialYearLabel } from '@/lib/tax/rates';
import type { HouseholdContext } from './context';
import { listMembers, type Member } from './members';
import type { DbTx } from './transactions';

export type TaxProfileRow = {
  paygGrossCents: number;
  paygWithheldCents: number;
  updatedAt: Date;
};

export type PersonTax = {
  member: Member;
  profile: TaxProfileRow | null; // null：还没填（R14.6）
  estimate: MemberTaxEstimate;
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

// Tax (ATO) 不是系统分类：按名字找一级 Income 下的 Tax (ATO)，不区分大小写
// 含已归档的，老拆分可能还指着它。找不到返回 null
async function findTaxCategoryId(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
): Promise<string | null> {
  const rows = await tx
    .select({ id: category.id, parentId: category.parentId, nameEn: category.nameEn })
    .from(category)
    .where(eq(category.householdId, ctx.householdId));
  const is = (name: string, expected: string) => name.trim().toLowerCase() === expected;
  const incomeIds = new Set(
    rows.filter((c) => c.parentId === null && is(c.nameEn, 'income')).map((c) => c.id),
  );
  const tax = rows.find(
    (c) => c.parentId !== null && incomeIds.has(c.parentId) && is(c.nameEn, 'tax (ato)'),
  );
  return tax?.id ?? null;
}

// 这个财年内的拆分，pending 也算（R10）
async function loadYearSplits(
  tx: DbTx | typeof db,
  ctx: HouseholdContext,
  financialYear: number,
): Promise<StatSplit[]> {
  const { start, end } = financialYearRange(financialYear);
  return tx
    .select({
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
      updatedAt: taxProfile.updatedAt,
    })
    .from(taxProfile)
    .where(
      and(eq(taxProfile.householdId, ctx.householdId), eq(taxProfile.financialYear, financialYear)),
    );
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
          findTaxCategoryId(tx, ctx),
        ]),
      { accessMode: 'read only' },
    ),
  ]);
  const [splits, profiles, taxCategoryId] = data;

  const estimates = estimateHouseholdTax({
    splits,
    members,
    profiles: profiles.map((p) => ({ ...p, financialYear })),
    // 找不到 Tax (ATO) 时传空 id，不会匹配任何拆分，已预缴就是 0
    taxCategoryId: taxCategoryId ?? '',
    financialYear,
  });

  const byId = new Map(members.map((m) => [m.id, m]));
  const persons = estimates.map((estimate): PersonTax => {
    const p = profiles.find((r) => r.memberId === estimate.memberId);
    return {
      member: byId.get(estimate.memberId)!,
      profile: p
        ? {
            paygGrossCents: p.paygGrossCents,
            paygWithheldCents: p.paygWithheldCents,
            updatedAt: p.updatedAt,
          }
        : null,
      estimate,
    };
  });

  return { missingRates: null, financialYear, taxCategoryMissing: taxCategoryId === null, persons };
}

// ---------- 写入 ----------

const amountSchema = z.string().max(100);

const saveSchema = z.object({
  memberId: z.uuid(),
  financialYear: z.number().int(),
  paygGross: amountSchema, // 元，"60000.00"
  paygWithheld: amountSchema,
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

// upsert (member_id, financial_year)。两个都填 0 也照样保存：等于"填过了，没有工资"
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

  const paygGrossCents = parseDollars(parsed.data.paygGross);
  const paygWithheldCents = parseDollars(parsed.data.paygWithheld);
  if (paygGrossCents === null || paygWithheldCents === null) {
    return { ok: false, reason: 'invalid', message: '金额要是 0 或正数，最多两位小数' };
  }
  if (paygWithheldCents > paygGrossCents) {
    return { ok: false, reason: 'invalid', message: '已代扣的税不能超过税前总额' };
  }

  // 只能是本家庭、没归档、kind = person 的 member
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
  if (!m) return MEMBER_NOT_FOUND;

  await db
    .insert(taxProfile)
    .values({
      householdId: ctx.householdId,
      memberId,
      financialYear,
      paygGrossCents,
      paygWithheldCents,
    })
    .onConflictDoUpdate({
      target: [taxProfile.memberId, taxProfile.financialYear],
      // $onUpdate 只在 update() 里生效，upsert 要自己写 updated_at
      set: { paygGrossCents, paygWithheldCents, updatedAt: new Date() },
    });
  return { ok: true };
}
