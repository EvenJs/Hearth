import { describe, expect, it } from 'vitest';
import { processFile } from '@/lib/import/process';
import type { StatSplit } from '@/lib/rules/stats';
import { readFixture } from '../../../tests/helpers/fixtures';
import { buildTestHousehold } from '../../../tests/helpers/household';
import {
  calculateTax,
  estimateHouseholdTax,
  financialYearOf,
  financialYearRange,
  incomeTaxCents,
  preTaxIncomeByPerson,
} from './estimate';
import { getTaxRates } from './rates';

// 期望值来自 business-rules.md R14 和 fixtures/README.md "税后估算（R14，财年 2026）"

const h = buildTestHousehold();
const mem = (name: string) => h.member(name).id;
const cat = (path: string) => h.category(path).id;
const TAX_CATEGORY = cat('Income / Tax (ATO)');

const $ = (dollars: number) => Math.round(dollars * 100); // 测试里写元，比较用分

function split(
  date: string,
  amountCents: number,
  member: string,
  isPreTax: boolean,
  path = 'Income / Interest',
): StatSplit {
  return { date, amountCents, categoryId: cat(path), memberId: mem(member), isPreTax };
}

describe('financialYearOf / financialYearRange（R14.1）', () => {
  it.each([
    ['2026-07-01', 2026],
    ['2027-06-30', 2026],
    ['2026-06-30', 2025],
    ['2026-10-23', 2026],
    ['2027-01-01', 2026],
  ])('R14.1: %s → %i', (date, fy) => {
    expect(financialYearOf(date)).toBe(fy);
  });

  it('R14.1: 2026 = 2026-07-01 to 2027-06-30', () => {
    expect(financialYearRange(2026)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
  });
});

describe('税率表（R14.4）', () => {
  it('R14.4: 2025-26 and 2026-27 exist', () => {
    expect(getTaxRates(2025)[1].ratePercent).toBe(16);
    expect(getTaxRates(2026)[1].ratePercent).toBe(15);
  });

  it.each([2024, 2027, 2030])(
    'R14.4: missing year %i throws instead of reusing an old table',
    (fy) => {
      expect(() => getTaxRates(fy)).toThrow();
    },
  );

  it('R14.4: brackets per table', () => {
    expect(incomeTaxCents(18200, 2026)).toBe(0);
    expect(incomeTaxCents(45000, 2026)).toBe($(4020));
    expect(incomeTaxCents(45000, 2025)).toBe($(4288));
    expect(incomeTaxCents(135000, 2026)).toBe($(4020 + 27000));
    expect(incomeTaxCents(190000, 2026)).toBe($(4020 + 27000 + 20350));
    expect(incomeTaxCents(200000, 2026)).toBe($(4020 + 27000 + 20350 + 4500));
  });
});

describe('calculateTax：R14.5 例子（2026-27）', () => {
  it.each([
    ['A：工资 + B2B', 60000, 30000, 90000, 17520, 1800, 19320],
    ['B：B2B 跨档', 40000, 10000, 50000, 5520, 1000, 6520],
    ['C：只有 B2B', 0, 30000, 30000, 1770, 600, 2370],
  ])('R14.5 %s', (_, gross, preTax, taxable, incomeTax, medicare, total) => {
    const r = calculateTax({
      financialYear: 2026,
      preTaxIncomeCents: $(preTax),
      profile: { paygGrossCents: $(gross), paygWithheldCents: 0 },
      prepaidCents: 0,
    });
    expect(r.taxableDollars).toBe(taxable);
    expect(r.incomeTaxCents).toBe($(incomeTax));
    expect(r.medicareCents).toBe($(medicare));
    expect(r.totalCents).toBe($(total));
  });

  it('R14.5 A: owing = 19,320 − 9,720 − 900 = 8,700', () => {
    const r = calculateTax({
      financialYear: 2026,
      preTaxIncomeCents: $(30000),
      profile: { paygGrossCents: $(60000), paygWithheldCents: $(9720) },
      prepaidCents: $(900),
    });
    expect(r.owingCents).toBe($(8700));
  });

  it('R14.5 B: 10,000 B2B adds 2,450 tax, not 32% of it', () => {
    const base = { financialYear: 2026, prepaidCents: 0 };
    const without = calculateTax({
      ...base,
      preTaxIncomeCents: 0,
      profile: { paygGrossCents: $(40000), paygWithheldCents: 0 },
    });
    const withB2b = calculateTax({
      ...base,
      preTaxIncomeCents: $(10000),
      profile: { paygGrossCents: $(40000), paygWithheldCents: 0 },
    });
    expect(withB2b.totalCents - without.totalCents).toBe($(2450));
  });

  it('R14.3: taxable is rounded down to whole dollars before the brackets', () => {
    const r = calculateTax({
      financialYear: 2026,
      preTaxIncomeCents: 1299,
      profile: { paygGrossCents: $(60000), paygWithheldCents: 0 },
      prepaidCents: 0,
    });
    expect(r.taxableDollars).toBe(60012);
  });

  it('R14.6: no tax_profile → payg is 0, hasProfile = false', () => {
    const r = calculateTax({
      financialYear: 2026,
      preTaxIncomeCents: $(30000),
      profile: null,
      prepaidCents: 0,
    });
    expect(r.hasProfile).toBe(false);
    expect(r.taxableDollars).toBe(30000);
    expect(r.totalCents).toBe($(2370));
  });

  it('R14.3: missing tax table throws', () => {
    expect(() =>
      calculateTax({ financialYear: 2027, preTaxIncomeCents: 0, profile: null, prepaidCents: 0 }),
    ).toThrow();
  });
});

describe('preTaxIncomeByPerson（R14.2）', () => {
  it('R14.5 D: 100.00 interest under Home → Male 50.00, Female 50.00', () => {
    const r = preTaxIncomeByPerson([split('2026-09-30', 10000, 'Home', true)], h.members, 2026);
    expect(r.get(mem('Male'))).toBe(5000);
    expect(r.get(mem('Female'))).toBe(5000);
    expect(r.has(mem('Home'))).toBe(false);
  });

  it('R14.2: remainder cents go to the person sorted first', () => {
    const r = preTaxIncomeByPerson([split('2026-09-30', 10001, 'Home', true)], h.members, 2026);
    expect(r.get(mem('Male'))).toBe(5001);
    expect(r.get(mem('Female'))).toBe(5000);
  });

  it('R14.2: order of the members list decides who gets the remainder', () => {
    const reversed = [h.member('Female'), h.member('Male'), h.member('Home')];
    const r = preTaxIncomeByPerson([split('2026-09-30', 10001, 'Home', true)], reversed, 2026);
    expect(r.get(mem('Female'))).toBe(5001);
    expect(r.get(mem('Male'))).toBe(5000);
  });

  it('R14.2: shared amounts are added up before splitting', () => {
    const r = preTaxIncomeByPerson(
      [split('2026-08-31', 1, 'Home', true), split('2026-09-30', 2, 'Home', true)],
      h.members,
      2026,
    );
    expect(r.get(mem('Male'))).toBe(2);
    expect(r.get(mem('Female'))).toBe(1);
  });

  it('R14.2: own pre-tax income plus share of Home', () => {
    const r = preTaxIncomeByPerson(
      [
        split('2026-09-25', 300000, 'Female', true, 'Income / Contract income (B2B)'),
        split('2026-09-30', 1234, 'Female', true),
        split('2026-09-30', 10000, 'Home', true),
      ],
      h.members,
      2026,
    );
    expect(r.get(mem('Female'))).toBe(300000 + 1234 + 5000);
    expect(r.get(mem('Male'))).toBe(5000);
  });

  it('R14.2: non pre-tax splits and other financial years are ignored', () => {
    const r = preTaxIncomeByPerson(
      [
        split('2026-09-01', 41000, 'Female', false, 'Income / Salary'),
        split('2026-06-30', 1234, 'Female', true),
        split('2027-07-01', 1234, 'Female', true),
      ],
      h.members,
      2026,
    );
    expect(r.get(mem('Female'))).toBe(0);
    expect(r.get(mem('Male'))).toBe(0);
  });
});

describe('estimateHouseholdTax：cba/female-2026-09.csv（fixtures R14）', () => {
  const result = processFile(readFixture('cba/female-2026-09.csv'), h.account('CBA Female'), h);
  if (!result.ok) throw new Error(result.message);
  const imported: StatSplit[] = result.rows.map((r) => ({
    date: r.date,
    amountCents: r.amountCents,
    categoryId: r.categoryId,
    memberId: r.memberId,
    isPreTax: r.isPreTax,
  }));

  const profiles = [
    {
      memberId: mem('Female'),
      financialYear: 2026,
      paygGrossCents: $(60000),
      paygWithheldCents: $(9720),
    },
  ];

  const estimate = (splits: StatSplit[]) =>
    estimateHouseholdTax({
      splits,
      members: h.members,
      profiles,
      taxCategoryId: TAX_CATEGORY,
      financialYear: 2026,
    });

  const of = (rs: ReturnType<typeof estimate>, name: string) => {
    const r = rs.find((x) => x.memberId === mem(name));
    if (!r) throw new Error(`没有 ${name}`);
    return r;
  };

  it('R14: just imported (#3 not categorised yet) → owing -896.16', () => {
    const f = of(estimate(imported), 'Female');
    expect(f.preTaxIncomeCents).toBe(1234);
    expect(f.taxableDollars).toBe(60012);
    expect(f.incomeTaxCents).toBe($(8523.6));
    expect(f.medicareCents).toBe($(1200.24));
    expect(f.totalCents).toBe($(9723.84));
    expect(f.prepaidCents).toBe($(900));
    expect(f.owingCents).toBe($(-896.16));
  });

  it('R14: after #3 becomes Contract income → owing 63.84', () => {
    const splits = [...imported];
    splits[2] = {
      ...splits[2],
      categoryId: cat('Income / Contract income (B2B)'),
      isPreTax: true,
    };
    const f = of(estimate(splits), 'Female');
    expect(f.preTaxIncomeCents).toBe($(3012.34));
    expect(f.taxableDollars).toBe(63012);
    expect(f.incomeTaxCents).toBe($(9423.6));
    expect(f.medicareCents).toBe($(1260.24));
    expect(f.totalCents).toBe($(10683.84));
    expect(f.prepaidCents).toBe($(900));
    expect(f.owingCents).toBe($(63.84));
  });

  it('R14.6: Male has no tax_profile and no pre-tax income → all 0', () => {
    const m = of(estimate(imported), 'Male');
    expect(m).toEqual({
      memberId: mem('Male'),
      hasProfile: false,
      preTaxIncomeCents: 0,
      taxableDollars: 0,
      incomeTaxCents: 0,
      medicareCents: 0,
      totalCents: 0,
      paygWithheldCents: 0,
      prepaidCents: 0,
      owingCents: 0,
    });
  });

  it('R14.2: only person members get a card (no Home)', () => {
    expect(estimate(imported).map((r) => r.memberId)).toEqual([mem('Male'), mem('Female')]);
  });

  it('R14.3: prepaid only counts negative Tax (ATO) splits of that person in that year', () => {
    const splits = [
      ...imported,
      split('2026-10-01', 50000, 'Female', false, 'Income / Tax (ATO)'), // 退税不算
      split('2026-10-01', -20000, 'Home', false, 'Income / Tax (ATO)'), // 不是她的
      split('2026-06-30', -30000, 'Female', false, 'Income / Tax (ATO)'), // 上一个财年
    ];
    expect(of(estimate(splits), 'Female').prepaidCents).toBe($(900));
  });

  it('R14.3: profile of another year is not used', () => {
    const rs = estimateHouseholdTax({
      splits: imported,
      members: h.members,
      profiles: [{ ...profiles[0], financialYear: 2025 }],
      taxCategoryId: TAX_CATEGORY,
      financialYear: 2026,
    });
    expect(of(rs, 'Female').hasProfile).toBe(false);
    expect(of(rs, 'Female').taxableDollars).toBe(12);
  });
});
