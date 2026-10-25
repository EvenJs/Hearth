import { describe, expect, it } from 'vitest';
import {
  centsToAmountInput,
  memberSourceLabel,
  parseSplitAmountInput,
  splitAmountPreview,
} from './split-form';

// 期望值来自 business-rules.md R5、R15.2、R15.3、R15.5，fixtures/README 的拆分用例
// #19 COLES -58.40

describe('parseSplitAmountInput（R15.2：用户填正数）', () => {
  it('R15.2: "15.00" → 1500, "8" → 800, "0.5" → 50', () => {
    expect(parseSplitAmountInput('15.00')).toEqual({ ok: true, cents: 1500 });
    expect(parseSplitAmountInput(' 8 ')).toEqual({ ok: true, cents: 800 });
    expect(parseSplitAmountInput('0.5')).toEqual({ ok: true, cents: 50 });
  });

  it('R15.2: 金额必须 > 0', () => {
    expect(parseSplitAmountInput('0').ok).toBe(false);
    expect(parseSplitAmountInput('0.00').ok).toBe(false);
  });

  it('R15.2: 不接受正负号、空、多于 2 位小数、非数字', () => {
    for (const s of ['-15', '+15', '', '  ', '15.001', 'abc', '1,500', '$15']) {
      expect(parseSplitAmountInput(s).ok, s).toBe(false);
    }
  });
});

describe('splitAmountPreview（R15.2、R15.3 主拆分剩余）', () => {
  it('R15.5: 主拆分 -58.40 拆出 15.00 → 剩 -43.40', () => {
    expect(splitAmountPreview({ primaryCents: -5840, inputCents: 1500 })).toEqual({
      ok: true,
      remainingCents: -4340,
      limitCents: 5840,
    });
  });

  it('R15.5: 主拆分 -43.40 再拆出 8.00 → 剩 -35.40', () => {
    expect(splitAmountPreview({ primaryCents: -4340, inputCents: 800 })).toMatchObject({
      ok: true,
      remainingCents: -3540,
    });
  });

  it('R15.5: 主拆分 -35.40 拆出 50.00 → 不通过，上限 35.40', () => {
    expect(splitAmountPreview({ primaryCents: -3540, inputCents: 5000 })).toMatchObject({
      ok: false,
      limitCents: 3540,
    });
  });

  it('R15.2: 等于主拆分也不通过（主拆分不能变成 0）', () => {
    expect(splitAmountPreview({ primaryCents: -3540, inputCents: 3540 }).ok).toBe(false);
  });

  it('R15.2: 正数交易同样按绝对值', () => {
    expect(splitAmountPreview({ primaryCents: 4580, inputCents: 1000 })).toEqual({
      ok: true,
      remainingCents: 3580,
      limitCents: 4580,
    });
  });

  it('R15.3: 改非主拆分金额，差额从主拆分补或扣', () => {
    // 主 -35.40，Cosmetics -8.00 改成 10.00 → 主 -33.40；上限 35.40 + 8.00
    expect(
      splitAmountPreview({ primaryCents: -3540, currentCents: -800, inputCents: 1000 }),
    ).toEqual({ ok: true, remainingCents: -3340, limitCents: 4340 });
    // 改成 43.40 → 主拆分变 0，不通过
    expect(
      splitAmountPreview({ primaryCents: -3540, currentCents: -800, inputCents: 4340 }).ok,
    ).toBe(false);
  });

  it('还没填金额时，剩余 = 主拆分当前金额，不算通过', () => {
    expect(splitAmountPreview({ primaryCents: -5840, inputCents: null })).toEqual({
      ok: false,
      remainingCents: -5840,
      limitCents: 5840,
    });
  });
});

describe('memberSourceLabel（R5 member_source 说明）', () => {
  it('R5: 四种来源', () => {
    expect(memberSourceLabel('manual', '1111')).toBe('手动指定');
    expect(memberSourceLabel('category', '1111')).toBe('按分类');
    expect(memberSourceLabel('card', '1111')).toBe('卡号 1111');
    expect(memberSourceLabel('account', null)).toBe('账户默认');
  });

  it('R5: card 来源但交易没有卡号时不显示 null', () => {
    expect(memberSourceLabel('card', null)).toBe('按卡号');
  });
});

describe('centsToAmountInput（编辑拆分时填好原来的金额）', () => {
  it('R15.3: 按绝对值填正数，两位小数，能被 parseSplitAmountInput 读回', () => {
    expect(centsToAmountInput(-800)).toBe('8.00');
    expect(centsToAmountInput(-1505)).toBe('15.05');
    expect(centsToAmountInput(4580)).toBe('45.80');
    expect(centsToAmountInput(-5)).toBe('0.05');
    for (const c of [-800, -1505, 4580, -5]) {
      expect(parseSplitAmountInput(centsToAmountInput(c))).toEqual({
        ok: true,
        cents: Math.abs(c),
      });
    }
  });
});
