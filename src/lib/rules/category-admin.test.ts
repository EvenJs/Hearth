import { describe, expect, it } from 'vitest';
import { buildTestHousehold } from '../../../tests/helpers/household';
import {
  CATEGORY_NAME_MAX,
  checkCategoryEdit,
  checkNewCategory,
  newCategorySortOrder,
  normalizeCategoryName,
  planArchive,
  planUnarchive,
  type AdminCategory,
} from './category-admin';

// 期望值来自 business-rules.md R16.3、R19.2、R19.3、R19.4 和 docs/tasks/m6.5.md M6.5-5

const h = buildTestHousehold();

// 测试家庭没有 sortOrder、isArchived，照 seed 脚本补上：
// 一级（含系统分类）按顺序 0、1、2…，二级在各自一级下按顺序 0、1、2…（Other 是最后一个）
function adminCategories(): AdminCategory[] {
  let top = 0;
  const childIdx = new Map<string, number>();
  return h.categories.map((c) => {
    if (c.parentId === null) return { ...c, sortOrder: top++, isArchived: false };
    const i = childIdx.get(c.parentId) ?? 0;
    childIdx.set(c.parentId, i + 1);
    return { ...c, sortOrder: i, isArchived: false };
  });
}

const cats = adminCategories();
const byPath = (path: string, list: readonly AdminCategory[] = cats) =>
  list.find((c) => c.id === h.category(path).id)!;
const ENT = byPath('Entertainment & eat-out');
const ENT_OTHER = cats.find((c) => c.parentId === ENT.id && c.isOther)!;
const COFFEE = byPath('Entertainment & eat-out / Coffee & tea');
const INCOME_TOP = cats.find((c) => c.parentId === null && c.kind === 'income')!;
const INCOME_CHILD = cats.find((c) => c.parentId === INCOME_TOP.id && !c.isOther)!;
const UNCATEGORIZED = cats.find((c) => c.systemKey === 'uncategorized')!;
const HOME = h.member('Home').id;

const maxExpenseTop = Math.max(
  ...cats.filter((c) => c.parentId === null && c.kind === 'expense').map((c) => c.sortOrder),
);

// 在 Entertainment & eat-out 下加一个 Gaming 二级
function withGaming(isArchived: boolean): AdminCategory[] {
  return [
    ...cats,
    {
      id: 'category:Entertainment & eat-out / Gaming',
      parentId: ENT.id,
      nameEn: 'Gaming',
      kind: 'expense',
      systemKey: null,
      defaultMemberId: null,
      isPreTaxDefault: false,
      isOther: false,
      sortOrder: ENT_OTHER.sortOrder,
      isArchived,
    },
  ];
}

function archived(ids: readonly string[]): AdminCategory[] {
  const set = new Set(ids);
  return cats.map((c) => (set.has(c.id) ? { ...c, isArchived: true } : c));
}

function expectError(
  result: { ok: true } | { ok: false; message: string },
  pattern?: RegExp,
): string {
  expect(result.ok).toBe(false);
  const message = result.ok ? '' : result.message;
  if (pattern) expect(message).toMatch(pattern);
  return message;
}

// ---------- R19.2 名字 ----------

describe('normalizeCategoryName（R19.2）', () => {
  it('R19.2: trims and collapses inner spaces', () => {
    expect(normalizeCategoryName('  Kids   stuff  ')).toEqual({ ok: true, value: 'Kids stuff' });
  });

  it('R19.2: empty or spaces only is an error', () => {
    expectError(normalizeCategoryName(''));
    expectError(normalizeCategoryName('   '));
  });

  it('R19.2: 50 characters is fine, 51 is an error (counted after normalising)', () => {
    expect(normalizeCategoryName('a'.repeat(CATEGORY_NAME_MAX)).ok).toBe(true);
    expect(normalizeCategoryName(` ${'a'.repeat(CATEGORY_NAME_MAX)} `).ok).toBe(true);
    expectError(normalizeCategoryName('a'.repeat(CATEGORY_NAME_MAX + 1)), /50/);
  });
});

// ---------- R19.2 新建 ----------

describe('checkNewCategory（R19.2）', () => {
  it('R19.2: new expense top Kids comes with an Other child and sorts last among expense tops', () => {
    const r = checkNewCategory({ nameEn: ' Kids ', parentId: null, kind: 'expense' }, cats);
    expect(r).toEqual({
      ok: true,
      value: {
        category: {
          parentId: null,
          nameEn: 'Kids',
          kind: 'expense',
          defaultMemberId: null,
          isPreTaxDefault: false,
          isOther: false,
          sortOrder: maxExpenseTop + 1,
        },
        other: {
          nameEn: 'Other',
          kind: 'expense',
          defaultMemberId: null,
          isPreTaxDefault: false,
          isOther: true,
          sortOrder: 0,
        },
        moveOther: null,
      },
    });
  });

  it('R19.2: top must pick expense or income', () => {
    expectError(checkNewCategory({ nameEn: 'Kids', parentId: null }, cats), /类型/);
    expectError(
      checkNewCategory({ nameEn: 'Kids', parentId: null, kind: 'system' as never }, cats),
      /类型/,
    );
  });

  it('R19.2: default member is kept', () => {
    const r = checkNewCategory(
      { nameEn: 'Kids', parentId: null, kind: 'expense', defaultMemberId: HOME },
      cats,
    );
    expect(r.ok && r.value.category.defaultMemberId).toBe(HOME);
  });

  it('R19.2: Gaming under Entertainment & eat-out takes the slot before Other, Other moves back', () => {
    const r = checkNewCategory({ nameEn: 'Gaming', parentId: ENT.id }, cats);
    expect(r).toEqual({
      ok: true,
      value: {
        category: {
          parentId: ENT.id,
          nameEn: 'Gaming',
          kind: 'expense',
          defaultMemberId: null,
          isPreTaxDefault: false,
          isOther: false,
          sortOrder: ENT_OTHER.sortOrder,
        },
        other: null,
        moveOther: { id: ENT_OTHER.id, sortOrder: ENT_OTHER.sortOrder + 1 },
      },
    });
  });

  it('R19.2: child kind follows the top, even if the input says otherwise', () => {
    const r = checkNewCategory({ nameEn: 'Gaming', parentId: ENT.id, kind: 'income' }, cats);
    expect(r.ok && r.value.category.kind).toBe('expense');
  });

  it('R19.2: cannot create under a child (two levels only)', () => {
    expectError(checkNewCategory({ nameEn: 'Flat white', parentId: COFFEE.id }, cats), /两级/);
  });

  it('R19.2: cannot create under a system category, or under a parent that does not exist', () => {
    expectError(checkNewCategory({ nameEn: 'X', parentId: UNCATEGORIZED.id }, cats));
    expectError(checkNewCategory({ nameEn: 'X', parentId: 'category:nope' }, cats));
  });

  it('R19.2: "  gaming  " clashes with existing Gaming under the same top (case-insensitive)', () => {
    expectError(
      checkNewCategory({ nameEn: '  gaming  ', parentId: ENT.id }, withGaming(false)),
      /Gaming/,
    );
  });

  it('R19.2: clash with an archived Gaming tells you to unarchive it', () => {
    expectError(
      checkNewCategory({ nameEn: '  gaming  ', parentId: ENT.id }, withGaming(true)),
      /已有归档的分类 Gaming.*显示已归档.*取消归档/,
    );
  });

  it('R19.2: same name under a different top is fine', () => {
    const groceries = byPath('Groceries');
    expect(
      checkNewCategory({ nameEn: 'Gaming', parentId: groceries.id }, withGaming(false)).ok,
    ).toBe(true);
  });

  it('R19.2: tops clash with each other, including income vs expense', () => {
    expectError(
      checkNewCategory({ nameEn: ENT.nameEn.toUpperCase(), parentId: null, kind: 'income' }, cats),
    );
  });

  it('R19.2: a top named like a child elsewhere is fine', () => {
    expect(
      checkNewCategory({ nameEn: 'Coffee & tea', parentId: null, kind: 'expense' }, cats).ok,
    ).toBe(true);
  });

  it('R19.2: pre-tax can be ticked on an income child', () => {
    const r = checkNewCategory(
      { nameEn: 'Dividends', parentId: INCOME_TOP.id, isPreTaxDefault: true },
      cats,
    );
    expect(r.ok && r.value.category.isPreTaxDefault).toBe(true);
    expect(r.ok && r.value.category.kind).toBe('income');
  });

  it('R19.2: pre-tax on an expense child or on a top is an error', () => {
    expectError(
      checkNewCategory({ nameEn: 'Gaming', parentId: ENT.id, isPreTaxDefault: true }, cats),
      /税前/,
    );
    expectError(
      checkNewCategory(
        { nameEn: 'Side', parentId: null, kind: 'income', isPreTaxDefault: true },
        cats,
      ),
      /税前/,
    );
  });

  it('R19.2: bad name is reported before anything else', () => {
    expectError(checkNewCategory({ nameEn: '  ', parentId: ENT.id }, cats), /不能为空/);
  });
});

describe('newCategorySortOrder（R19.2）', () => {
  it('R19.2: top goes after the max of its own kind; empty group starts at 0', () => {
    const maxIncomeTop = Math.max(
      ...cats.filter((c) => c.parentId === null && c.kind === 'income').map((c) => c.sortOrder),
    );
    expect(newCategorySortOrder(cats, { parentId: null, kind: 'income' })).toEqual({
      sortOrder: maxIncomeTop + 1,
      moveOther: null,
    });
    const noIncome = cats.filter((c) => c.kind !== 'income');
    expect(newCategorySortOrder(noIncome, { parentId: null, kind: 'income' })).toEqual({
      sortOrder: 0,
      moveOther: null,
    });
  });

  it('R19.2: archived siblings count too, so a new child never lands on the same slot', () => {
    const list = withGaming(true);
    const r = newCategorySortOrder(
      list.map((c) => (c.id === ENT_OTHER.id ? { ...c, sortOrder: ENT_OTHER.sortOrder + 1 } : c)),
      { parentId: ENT.id, kind: 'expense' },
    );
    expect(r).toEqual({
      sortOrder: ENT_OTHER.sortOrder + 1,
      moveOther: { id: ENT_OTHER.id, sortOrder: ENT_OTHER.sortOrder + 2 },
    });
  });
});

// ---------- R19.3 修改 ----------

describe('checkCategoryEdit（R19.3）', () => {
  it('R19.3: rename, default member and pre-tax on an income child are fine; name is normalised', () => {
    expect(
      checkCategoryEdit(INCOME_CHILD, {
        nameEn: '  Pay   rise ',
        defaultMemberId: HOME,
        isPreTaxDefault: true,
      }),
    ).toEqual({
      ok: true,
      value: { nameEn: 'Pay rise', defaultMemberId: HOME, isPreTaxDefault: true },
    });
  });

  it('R19.3: default member can be cleared', () => {
    expect(checkCategoryEdit(COFFEE, { defaultMemberId: null })).toEqual({
      ok: true,
      value: { defaultMemberId: null },
    });
  });

  it('R19.3: Other cannot be renamed, but its default member can change', () => {
    expectError(checkCategoryEdit(ENT_OTHER, { nameEn: 'Misc' }), /Other/);
    expect(checkCategoryEdit(ENT_OTHER, { defaultMemberId: HOME })).toEqual({
      ok: true,
      value: { defaultMemberId: HOME },
    });
  });

  it('R19.3: Other with its own name sent back (form sends everything) is not a rename', () => {
    expect(checkCategoryEdit(ENT_OTHER, { nameEn: 'Other', defaultMemberId: HOME }).ok).toBe(true);
  });

  it('R19.3: Other of an income top can change pre-tax', () => {
    const incomeOther = cats.find((c) => c.parentId === INCOME_TOP.id && c.isOther)!;
    expect(checkCategoryEdit(incomeOther, { isPreTaxDefault: true }).ok).toBe(true);
  });

  it('R19.3: system categories cannot change anything', () => {
    expectError(checkCategoryEdit(UNCATEGORIZED, { nameEn: 'Unsorted' }), /系统分类/);
    expectError(checkCategoryEdit(UNCATEGORIZED, { defaultMemberId: HOME }), /系统分类/);
  });

  it('R19.3: kind and parent cannot change', () => {
    expectError(checkCategoryEdit(COFFEE, { kind: 'income' }), /类型/);
    expectError(checkCategoryEdit(COFFEE, { parentId: byPath('Groceries').id }), /一级/);
    expectError(checkCategoryEdit(ENT, { parentId: byPath('Groceries').id }), /一级/);
  });

  it('R19.3: kind and parent sent back unchanged are fine', () => {
    expect(
      checkCategoryEdit(COFFEE, { kind: 'expense', parentId: ENT.id, nameEn: 'Coffee' }).ok,
    ).toBe(true);
  });

  it('R19.3: pre-tax only on income children', () => {
    expectError(checkCategoryEdit(COFFEE, { isPreTaxDefault: true }), /税前/);
    expectError(checkCategoryEdit(INCOME_TOP, { isPreTaxDefault: true }), /税前/);
    expect(checkCategoryEdit(COFFEE, { isPreTaxDefault: false }).ok).toBe(true);
  });

  it('R19.3 + R19.2: bad new name is an error', () => {
    expectError(checkCategoryEdit(COFFEE, { nameEn: ' ' }), /不能为空/);
  });

  it('R19.3 + R19.2: rename clashing with a sibling is an error when categories are passed', () => {
    expectError(checkCategoryEdit(COFFEE, { nameEn: 'gaming' }, withGaming(true)), /取消归档/);
    expect(checkCategoryEdit(COFFEE, { nameEn: 'COFFEE & TEA' }, cats).ok).toBe(true); // 自己不算
  });
});

// ---------- R19.4 归档 ----------

describe('planArchive（R19.4）', () => {
  const entIds = [ENT.id, ...cats.filter((c) => c.parentId === ENT.id).map((c) => c.id)];

  it('R19.4: one rule pointing at Coffee & tea blocks archiving it', () => {
    const r = planArchive(COFFEE.id, cats, new Map([[COFFEE.id, 1]]));
    expect(r).toMatchObject({
      ok: false,
      reason: 'has_rules',
      ruleCount: 1,
      ruleFilterTopId: ENT.id,
    });
    expectError(r, /有 1 条规则指向这个分类/);
  });

  it('R19.4: a rule pointing at a child blocks archiving the top', () => {
    const r = planArchive(ENT.id, cats, new Map([[COFFEE.id, 1]]));
    expect(r).toMatchObject({
      ok: false,
      reason: 'has_rules',
      ruleCount: 1,
      ruleFilterTopId: ENT.id,
    });
  });

  it('R19.4: rule count adds up the top and all its children', () => {
    const r = planArchive(
      ENT.id,
      cats,
      new Map([
        [COFFEE.id, 2],
        [ENT.id, 1],
        [byPath('Groceries / Supermarket').id, 5],
      ]),
    );
    expect(r).toMatchObject({ ok: false, ruleCount: 3 });
  });

  it('R19.4: with no rules, archiving the top returns it and all its children', () => {
    const r = planArchive(ENT.id, cats, new Map());
    expect(r.ok).toBe(true);
    expect(r.ok && [...r.ids].sort()).toEqual([...entIds].sort());
  });

  it('R19.4: zero counts in the map do not block', () => {
    expect(planArchive(COFFEE.id, cats, new Map([[COFFEE.id, 0]]))).toEqual({
      ok: true,
      ids: [COFFEE.id],
    });
  });

  it('R19.4: Other cannot be archived on its own', () => {
    expect(planArchive(ENT_OTHER.id, cats, new Map())).toMatchObject({
      ok: false,
      reason: 'other',
    });
  });

  it('R19.4: system categories cannot be archived', () => {
    expect(planArchive(UNCATEGORIZED.id, cats, new Map())).toMatchObject({
      ok: false,
      reason: 'system',
    });
  });

  it('R19.4: unknown or already archived is an error', () => {
    expect(planArchive('category:nope', cats, new Map())).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    expect(planArchive(COFFEE.id, archived([COFFEE.id]), new Map())).toMatchObject({
      ok: false,
      reason: 'already_archived',
    });
  });
});

describe('planUnarchive（R19.4）', () => {
  const entChildren = cats.filter((c) => c.parentId === ENT.id).map((c) => c.id);

  it('R19.4: child of an archived top cannot be unarchived on its own', () => {
    const list = archived([ENT.id, ...entChildren]);
    expectError(planUnarchive(COFFEE.id, list), /Entertainment & eat-out/);
  });

  it('R19.4: unarchiving the top brings back all its children, including ones archived before', () => {
    // Coffee & tea 先单独归档，后来整个一级归档
    const list = archived([ENT.id, ...entChildren]);
    const r = planUnarchive(ENT.id, list);
    expect(r.ok && [...r.ids].sort()).toEqual([ENT.id, ...entChildren].sort());
  });

  it('R19.4: archived child under a live top comes back alone', () => {
    expect(planUnarchive(COFFEE.id, archived([COFFEE.id]))).toEqual({ ok: true, ids: [COFFEE.id] });
  });

  it('R19.4: not archived or unknown is an error', () => {
    expectError(planUnarchive(COFFEE.id, cats));
    expectError(planUnarchive('category:nope', cats));
  });
});
