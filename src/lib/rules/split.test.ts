import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import { addSplit, removeSplit, updateSplitAmount, type SplitRow, type SplitTx } from './split';

// 期望值来自 business-rules.md R15.2、R15.3、R15.5 和 fixtures/README.md "拆分（R15）"

const h = buildTestHousehold();
const joint = h.account('ANZ Joint');
const cat = (path: string) => h.category(path).id;
const mem = (name: string) => h.member(name).id;

// joint-2026-09.csv #19：COLES -58.40，卡 1111，主拆分 Groceries / Supermarket，Home（category）
function coles(): SplitTx {
  return {
    accountId: joint.id,
    cardLast4: '1111',
    amountCents: -5840,
    splits: [
      {
        id: 'split:primary',
        isPrimary: true,
        amountCents: -5840,
        categoryId: cat('Groceries / Supermarket'),
        categorySource: 'rule',
        memberId: mem('Home'),
        memberSource: 'category',
        isPreTax: false,
        note: null,
      },
    ],
  };
}

// 测试里把新拆分的 id 填上，模拟入库
function apply(tx: SplitTx, splits: SplitRow[], newId = 'split:new'): SplitTx {
  return { ...tx, splits: splits.map((s) => ({ ...s, id: s.id ?? newId })) };
}

function ok<T>(r: { ok: true; splits: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.splits;
}

const sum = (tx: SplitTx) => tx.splits.reduce((a, s) => a + s.amountCents, 0);
const primaryOf = (tx: SplitTx) => tx.splits.find((s) => s.isPrimary)!;

describe('R15.5 例子', () => {
  const ctx = h;

  // 1. 拆出 15.00 → Household supplies，不选归属人
  const step1 = apply(
    coles(),
    ok(
      addSplit(
        coles(),
        { amountCents: 1500, categoryId: cat('Home & utilities / Household supplies') },
        ctx,
      ),
    ),
    'split:household',
  );

  // 2. 再拆出 8.00 → Cosmetics & toiletries，不选归属人
  const step2 = apply(
    step1,
    ok(
      addSplit(
        step1,
        { amountCents: 800, categoryId: cat('Personal & medical / Cosmetics & toiletries') },
        ctx,
      ),
    ),
    'split:cosmetics',
  );

  it('R15.2: primary becomes -43.40, new split -15.00 Home (category)', () => {
    expect(primaryOf(step1).amountCents).toBe(-4340);
    const s = step1.splits.find((x) => x.id === 'split:household')!;
    expect(s).toEqual({
      id: 'split:household',
      isPrimary: false,
      amountCents: -1500,
      categoryId: cat('Home & utilities / Household supplies'),
      categorySource: 'manual',
      memberId: mem('Home'),
      memberSource: 'category',
      isPreTax: false,
      note: null,
    });
  });

  it('R15.2: second split -8.00 Cosmetics goes to Male (card 1111), primary -35.40', () => {
    expect(primaryOf(step2).amountCents).toBe(-3540);
    const s = step2.splits.find((x) => x.id === 'split:cosmetics')!;
    expect(s.amountCents).toBe(-800);
    expect(s.memberId).toBe(mem('Male'));
    expect(s.memberSource).toBe('card');
    expect(step2.splits).toHaveLength(3);
  });

  it('R15.1: splits always add up to the transaction amount', () => {
    expect(sum(step1)).toBe(-5840);
    expect(sum(step2)).toBe(-5840);
  });

  it('R15.2: splitting 50.00 fails because it exceeds the primary 35.40', () => {
    const r = addSplit(step2, { amountCents: 5000, categoryId: cat('Groceries / Other') }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('35.40');
  });

  it('R15.3: deleting Cosmetics puts the amount back, primary -43.40', () => {
    const after = apply(step2, ok(removeSplit(step2, 'split:cosmetics')));
    expect(primaryOf(after).amountCents).toBe(-4340);
    expect(after.splits.map((s) => s.id)).toEqual(['split:primary', 'split:household']);
    expect(sum(after)).toBe(-5840);
  });
});

describe('addSplit 校验（R15.2）', () => {
  const groceriesOther = cat('Groceries / Other');

  it.each([0, -100, 5840, 6000, 12.5])('R15.2: amount %d is rejected', (amountCents) => {
    expect(addSplit(coles(), { amountCents, categoryId: groceriesOther }, h).ok).toBe(false);
  });

  it('R15.2: amount just below the primary is fine', () => {
    const splits = ok(addSplit(coles(), { amountCents: 5839, categoryId: groceriesOther }, h));
    expect(splits[0].amountCents).toBe(-1);
  });

  it('R15.2: chosen member → manual', () => {
    const splits = ok(
      addSplit(
        coles(),
        { amountCents: 100, categoryId: groceriesOther, memberId: mem('Female'), note: '给她的' },
        h,
      ),
    );
    expect(splits[1]).toMatchObject({
      memberId: mem('Female'),
      memberSource: 'manual',
      note: '给她的',
    });
  });

  it('R15.2: positive transaction (refund or income) keeps the positive sign', () => {
    const income: SplitTx = {
      accountId: h.account('CBA Female').id,
      cardLast4: null,
      amountCents: 300000,
      splits: [
        {
          ...coles().splits[0],
          amountCents: 300000,
          categoryId: cat('Income / Contract income (B2B)'),
          memberId: mem('Female'),
          memberSource: 'account',
          isPreTax: true,
        },
      ],
    };
    const splits = ok(
      addSplit(income, { amountCents: 30000, categoryId: cat('Income / Other') }, h),
    );
    expect(splits.map((s) => s.amountCents)).toEqual([270000, 30000]);
    // R15.2 第 4 步：is_pre_tax 按新分类默认
    expect(splits[1].isPreTax).toBe(false);
    expect(splits[1]).toMatchObject({ memberId: mem('Female'), memberSource: 'account' });
  });

  it('R15.2: is_pre_tax follows the new category default', () => {
    const splits = ok(
      addSplit(coles(), { amountCents: 100, categoryId: cat('Income / Interest') }, h),
    );
    expect(splits[1].isPreTax).toBe(true);
  });
});

describe('updateSplitAmount（R15.3）', () => {
  // 主 -35.40、Household -15.00、Cosmetics -8.00
  function three(): SplitTx {
    const tx = coles();
    const base = tx.splits[0];
    return {
      ...tx,
      splits: [
        { ...base, amountCents: -3540 },
        {
          ...base,
          id: 'split:household',
          isPrimary: false,
          amountCents: -1500,
          categoryId: cat('Home & utilities / Household supplies'),
          categorySource: 'manual',
        },
        {
          ...base,
          id: 'split:cosmetics',
          isPrimary: false,
          amountCents: -800,
          categoryId: cat('Personal & medical / Cosmetics & toiletries'),
          categorySource: 'manual',
          memberId: mem('Male'),
          memberSource: 'card',
        },
      ],
    };
  }

  it('R15.3: increasing a split takes the difference from the primary', () => {
    const splits = ok(updateSplitAmount(three(), 'split:household', 2000));
    expect(splits.map((s) => s.amountCents)).toEqual([-3040, -2000, -800]);
  });

  it('R15.3: decreasing a split gives the difference back to the primary', () => {
    const splits = ok(updateSplitAmount(three(), 'split:household', 500));
    expect(splits.map((s) => s.amountCents)).toEqual([-4540, -500, -800]);
  });

  it('R15.3: primary cannot become 0 or flip sign', () => {
    expect(updateSplitAmount(three(), 'split:household', 5040).ok).toBe(false); // 主拆分变 0
    expect(updateSplitAmount(three(), 'split:household', 5039).ok).toBe(true);
    expect(updateSplitAmount(three(), 'split:household', 0).ok).toBe(false);
  });

  it('R15.3: the primary split amount cannot be edited directly', () => {
    expect(updateSplitAmount(three(), 'split:primary', 100).ok).toBe(false);
  });

  it('R15.3: unknown split id', () => {
    expect(updateSplitAmount(three(), 'nope', 100).ok).toBe(false);
  });
});

describe('removeSplit（R15.3）', () => {
  it('R15.3: the primary split cannot be deleted', () => {
    expect(removeSplit(coles(), 'split:primary').ok).toBe(false);
  });

  it('R15.3: unknown split id', () => {
    expect(removeSplit(coles(), 'nope').ok).toBe(false);
  });
});
