import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import type { EditCategory } from '@/lib/rules/split-edit';
import type { Account } from '@/lib/rules/types';
import {
  autoMember,
  changeKind,
  emptyValues,
  guessOnDescription,
  nextEntryValues,
  NO_CATEGORY,
  pickCategory,
  quickAddChips,
  quickAddSections,
  statusHint,
  toManualInput,
  type CategoryChoice,
  type QuickAddValues,
} from './quick-add';

// 期望值来自 business-rules.md R5、R8.1、R17.1–R17.4，和 M6-3 定下的边界情况：
// - 切换支出 / 收入时分类类型对不上 → 清掉、算没点过、按描述重新猜（2026-10-26）
// - 再点一次选中的 chip → 取消（未分类），算点过

const h = buildTestHousehold();
const cash: Account = {
  id: 'account:Cash',
  name: 'Cash',
  bank: 'cash',
  type: 'cash',
  defaultMemberId: h.member('Home').id,
  numberSuffix: null,
};
const accounts = [...h.accounts, cash];
const categories: EditCategory[] = h.categories;
const rules = h.rules;
const memberCtx = { categories, cards: h.cards, accounts };

const cat = (path: string) => h.category(path).id;
const mem = (name: string) => h.member(name).id;
const acc = (name: string) => h.account(name).id;

const guessed = (id: string): CategoryChoice => ({ categoryId: id, guessed: true, touched: false });
const picked = (id: string): CategoryChoice => ({ categoryId: id, guessed: false, touched: true });

describe('quickAddSections', () => {
  it('R17.1: 支出 → expense 一级（带二级）加现金支出、银行费用；没有收入、内部转账、未分类', () => {
    const s = quickAddSections(categories, 'expense');
    expect(s.groups.map((g) => g.kind)).toEqual(s.groups.map(() => 'expense'));
    expect(s.groups.map((g) => g.name)).toContain('Groceries');
    expect(s.groups.find((g) => g.name === 'Groceries')!.children.map((c) => c.name)).toContain(
      'Supermarket',
    );
    expect(s.system.map((g) => g.systemKey).sort()).toEqual(['bank_fee', 'cash_withdrawal']);
  });

  it('R17.1: 收入 → 只有 income 分类，没有系统分类', () => {
    const s = quickAddSections(categories, 'income');
    expect(s.groups.map((g) => g.name)).toEqual(['Income']);
    expect(s.groups[0].children.map((c) => c.name)).toContain('Interest');
    expect(s.system).toEqual([]);
  });

  it('R16.3: 归档的二级不出现；归档的一级连同二级都不出现', () => {
    const archived = categories.map((c) =>
      c.id === cat('Groceries / Supermarket') || c.id === cat('Transport & auto')
        ? { ...c, isArchived: true }
        : c,
    );
    const s = quickAddSections(archived, 'expense');
    const groceries = s.groups.find((g) => g.name === 'Groceries')!;
    expect(groceries.children.map((c) => c.name)).not.toContain('Supermarket');
    expect(s.groups.map((g) => g.name)).not.toContain('Transport & auto');
  });
});

describe('quickAddChips', () => {
  const frequent = [cat('Entertainment & eat-out / Lunches'), cat('Groceries / Supermarket')];

  it('R17.2: 没选分类 → 就是常用分类', () => {
    expect(quickAddChips(frequent, null)).toEqual(frequent);
  });

  it('选中的在常用里 → 不变', () => {
    expect(quickAddChips(frequent, cat('Groceries / Supermarket'))).toEqual(frequent);
  });

  it('选中的不在常用里（猜的、从"更多…"选的）→ 放在最前面', () => {
    const coffee = cat('Entertainment & eat-out / Coffee & tea');
    expect(quickAddChips(frequent, coffee)).toEqual([coffee, ...frequent]);
  });
});

describe('guessOnDescription', () => {
  it('R17.2: 描述 coles，没点过分类 → 猜 Groceries / Supermarket，标"猜的"', () => {
    expect(guessOnDescription(NO_CATEGORY, 'coles', 'expense', rules, categories)).toEqual(
      guessed(cat('Groceries / Supermarket')),
    );
  });

  it('R17.2: 先点了 Lunches 再改描述 → Lunches 不被覆盖', () => {
    const lunches = picked(cat('Entertainment & eat-out / Lunches'));
    expect(guessOnDescription(lunches, 'coles', 'expense', rules, categories)).toBe(lunches);
  });

  it('R17.2: 取消选择（点过、未分类）后改描述 → 也不猜', () => {
    const cleared: CategoryChoice = { categoryId: null, guessed: false, touched: true };
    expect(guessOnDescription(cleared, 'coles', 'expense', rules, categories)).toBe(cleared);
  });

  it('R17.2: 没命中 → 不预选', () => {
    expect(guessOnDescription(NO_CATEGORY, 'Corner Shop', 'expense', rules, categories)).toEqual(
      NO_CATEGORY,
    );
  });

  it('R17.2: 之前猜的，描述改成没命中的 → 清掉', () => {
    const before = guessed(cat('Groceries / Supermarket'));
    expect(guessOnDescription(before, 'Corner Shop', 'expense', rules, categories)).toEqual(
      NO_CATEGORY,
    );
  });

  it('R17.2: 切换在"收入"时 coles 不猜', () => {
    expect(guessOnDescription(NO_CATEGORY, 'coles', 'income', rules, categories)).toEqual(
      NO_CATEGORY,
    );
  });
});

describe('pickCategory', () => {
  it('点一个分类 → 用户选的，不是猜的', () => {
    const lunches = cat('Entertainment & eat-out / Lunches');
    expect(pickCategory(guessed(cat('Groceries / Supermarket')), lunches)).toEqual(picked(lunches));
  });

  it('再点一次选中的 → 取消，未分类，算点过', () => {
    const lunches = cat('Entertainment & eat-out / Lunches');
    expect(pickCategory(picked(lunches), lunches)).toEqual({
      categoryId: null,
      guessed: false,
      touched: true,
    });
  });

  it('点猜中的那个 chip → 取消', () => {
    const supermarket = cat('Groceries / Supermarket');
    expect(pickCategory(guessed(supermarket), supermarket)).toEqual({
      categoryId: null,
      guessed: false,
      touched: true,
    });
  });
});

describe('changeKind', () => {
  it('猜的 Groceries / Supermarket，切到收入 → 清掉，按收入重新猜（coles 猜不到）', () => {
    const r = changeKind(
      guessed(cat('Groceries / Supermarket')),
      'income',
      'coles',
      rules,
      categories,
    );
    expect(r).toEqual(NO_CATEGORY);
  });

  it('自己选的 Lunches，切到收入 → 也清掉，算没点过，重新猜', () => {
    const r = changeKind(
      picked(cat('Entertainment & eat-out / Lunches')),
      'income',
      'credit interest',
      rules,
      categories,
    );
    expect(r).toEqual(guessed(cat('Income / Interest')));
  });

  it('没选分类、没点过 → 按新的切换重新猜', () => {
    expect(changeKind(NO_CATEGORY, 'income', 'CREDIT INTEREST', rules, categories)).toEqual(
      guessed(cat('Income / Interest')),
    );
  });

  it('自己取消成未分类的 → 不动', () => {
    const cleared: CategoryChoice = { categoryId: null, guessed: false, touched: true };
    expect(changeKind(cleared, 'income', 'CREDIT INTEREST', rules, categories)).toBe(cleared);
  });

  it('分类和新切换类型一致 → 不动', () => {
    const fee = picked(h.systemCategory('bank_fee').id);
    expect(changeKind(fee, 'expense', 'x', rules, categories)).toBe(fee);
  });
});

describe('autoMember', () => {
  it('R17.3 / R5: Joint 选 Groceries / Supermarket → Home（category）', () => {
    expect(autoMember(acc('ANZ Joint'), cat('Groceries / Supermarket'), memberCtx)).toEqual({
      memberId: mem('Home'),
      memberSource: 'category',
    });
  });

  it('R5: ANZ Male 选 Coffee & tea → Male（account），手动录入没有卡号', () => {
    expect(
      autoMember(acc('ANZ Male'), cat('Entertainment & eat-out / Coffee & tea'), memberCtx),
    ).toEqual({ memberId: mem('Male'), memberSource: 'account' });
  });

  it('R5: 没选分类（未分类）→ 账户默认', () => {
    expect(autoMember(acc('CBA Female'), null, memberCtx)).toEqual({
      memberId: mem('Female'),
      memberSource: 'account',
    });
  });

  it('没选账户 → null', () => {
    expect(autoMember(null, cat('Groceries / Supermarket'), memberCtx)).toBeNull();
  });
});

describe('statusHint', () => {
  it('R8.1: 现金、ANZ Plus → confirmed', () => {
    expect(statusHint(cash).status).toBe('confirmed');
    expect(statusHint(h.account('ANZ Plus Male')).status).toBe('confirmed');
    expect(statusHint(cash).message).toBe('现金 / ANZ Plus 账户，保存后直接确认');
  });

  it('R8.1: ANZ、CBA → pending', () => {
    expect(statusHint(h.account('ANZ Joint')).status).toBe('pending');
    expect(statusHint(h.account('CBA Female')).status).toBe('pending');
    expect(statusHint(h.account('ANZ Joint')).message).toBe(
      'ANZ / CBA 账户会先记为待确认，导入时自动匹配',
    );
  });
});

describe('emptyValues / nextEntryValues', () => {
  it('R17.1 / R17.2: 新表单是支出、今天、上次账户，其余空的，归属人自动', () => {
    expect(emptyValues({ lastAccountId: cash.id, today: '2026-10-26' })).toEqual({
      amount: '',
      kind: 'expense',
      description: '',
      accountId: cash.id,
      date: '2026-10-26',
      category: NO_CATEGORY,
      memberId: null,
    });
  });

  it('R17.2: 没有上次账户 → 不预选', () => {
    expect(emptyValues({ lastAccountId: null, today: '2026-10-26' }).accountId).toBeNull();
  });

  it('R17.4: 保存并再记一笔 → 留账户、日期、切换；清金额、描述、分类，归属人回自动', () => {
    const prev: QuickAddValues = {
      amount: '50',
      kind: 'income',
      description: 'refund',
      accountId: acc('ANZ Joint'),
      date: '2026-10-20',
      category: picked(cat('Income / Interest')),
      memberId: mem('Female'),
    };
    expect(nextEntryValues(prev)).toEqual({
      amount: '',
      kind: 'income',
      description: '',
      accountId: acc('ANZ Joint'),
      date: '2026-10-20',
      category: NO_CATEGORY,
      memberId: null,
    });
  });
});

describe('toManualInput', () => {
  it('R17.3: 猜的分类带 categoryGuessed = true，自动的归属人是 null', () => {
    const v: QuickAddValues = {
      ...emptyValues({ lastAccountId: cash.id, today: '2026-10-26' }),
      amount: '12.50',
      description: 'coles',
      category: guessed(cat('Groceries / Supermarket')),
    };
    expect(toManualInput(v)).toEqual({
      ok: true,
      input: {
        amount: '12.50',
        kind: 'expense',
        description: 'coles',
        accountId: cash.id,
        date: '2026-10-26',
        categoryId: cat('Groceries / Supermarket'),
        categoryGuessed: true,
        memberId: null,
      },
    });
  });

  it('R17.3: 自己选的分类、归属人照传', () => {
    const v: QuickAddValues = {
      ...emptyValues({ lastAccountId: cash.id, today: '2026-10-26' }),
      category: picked(cat('Entertainment & eat-out / Lunches')),
      memberId: mem('Female'),
    };
    const r = toManualInput(v);
    expect(r.ok && r.input.categoryGuessed).toBe(false);
    expect(r.ok && r.input.memberId).toBe(mem('Female'));
  });

  it('R17.2: 没选账户（没有上次账户）→ 报"请选账户"，不发请求', () => {
    const v = emptyValues({ lastAccountId: null, today: '2026-10-26' });
    expect(toManualInput(v)).toEqual({ ok: false, errors: { accountId: '请选账户' } });
  });
});
